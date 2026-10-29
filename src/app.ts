// The HTTP app: the landing page, two x402-paid routes priced in USDG (ask an agent, hire a human), and the task board.
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isAddress, getAddress } from "ethers";
import { createHonoMiddleware, parsePaymentHeader } from "uvd-x402-sdk/backend";
import { answer } from "./agent.js";
import type { Chain, Tier } from "./chain.js";
import { USDG_DECIMALS, USDG_DOMAIN, WIF_DECIMALS, addressUrl, formatUnits, txUrl, type Config } from "./config.js";
import type { Store } from "./store.js";

export interface AppDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
  /** milliseconds a paid response waits for its $WIF cashback before answering "pending" */
  cashbackWaitMs?: number;
  log?: (msg: string) => void;
}

type Route = "ask" | "hire";

const MAX_TEXT = 500;

interface X402State {
  settle: () => Promise<{ success: boolean; transactionHash?: string; transaction?: string; payer?: string }>;
  verifyResult: { payer?: string };
  payment: unknown;
}

/**
 * The one payment header the SDK middleware pays from: PAYMENT-SIGNATURE, else X-PAYMENT, exactly as its own
 * `req.header("PAYMENT-SIGNATURE") || req.header("X-PAYMENT")`. Reading it any other way (the SDK's exported
 * extractPaymentFromHeaders prefers X-PAYMENT) lets a decoy in one header pick the price while the other one pays.
 * Two different payment headers in one request are refused outright.
 */
export function paymentHeaderOf(get: (name: string) => string | undefined): { value: string | null; conflict: boolean } {
  const ps = get("payment-signature") || null;
  const xp = get("x-payment") || null;
  return { value: ps || xp, conflict: !!ps && !!xp && ps !== xp };
}

export interface SignedPayment {
  payer: string;
  value: bigint | null;
  network: string;
}

/** what a payment header commits to: the payer, the amount and the network; null when the SDK could not route it */
export function signedPayment(value: string | null): SignedPayment | null {
  if (!value) return null;
  const p = parsePaymentHeader(value) as { network?: unknown; payload?: { authorization?: { from?: string; value?: string } } } | null;
  const from = p?.payload?.authorization?.from;
  if (!p || typeof p.network !== "string" || typeof from !== "string" || !isAddress(from)) return null;
  let amount: bigint | null = null;
  try {
    amount = BigInt(p.payload?.authorization?.value ?? "");
  } catch {
    amount = null;
  }
  return { payer: getAddress(from.toLowerCase()), value: amount, network: p.network };
}

/** an error's message without URLs: ethers puts the RPC URL (and any API key in it) into `info.requestUrl` */
export function safeMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string } | null;
  const m = err?.shortMessage ?? err?.message ?? String(e);
  return m.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, 200);
}

function text(body: unknown, key: string): string | null {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= MAX_TEXT ? t : null;
}

export function createApp({ cfg, chain, store, cashbackWaitMs = 15_000, log = console.log }: AppDeps) {
  const app = new Hono();
  const price = (route: Route, tier: Tier) =>
    route === "ask" ? (tier === "holder" ? cfg.prices.askHolder : cfg.prices.ask) : tier === "holder" ? cfg.prices.hireHolder : cfg.prices.hire;

  const descriptions: Record<Route, string> = {
    ask: `Ask the Flat Fee agent a question about ${cfg.chain.label}`,
    hire: "Hire a human for a small task through Flat Fee",
  };

  // one paywall per (route, tier): the tier only ever lowers the price, and it is read from the signed payer
  const paywalls = new Map<string, ReturnType<typeof createHonoMiddleware>>();
  for (const route of ["ask", "hire"] as const) {
    for (const tier of ["standard", "holder"] as const) {
      paywalls.set(
        `${route}:${tier}`,
        createHonoMiddleware({
          facilitatorUrl: cfg.facilitatorUrl,
          accepts: [
            {
              scheme: "exact",
              network: cfg.chain.name,
              asset: cfg.chain.usdg,
              amount: price(route, tier).toString(),
              payTo: cfg.payTo,
              description: descriptions[route],
              mimeType: "application/json",
              maxTimeoutSeconds: 300,
              extra: { ...USDG_DOMAIN },
              ...(cfg.publicUrl ? { resource: `${cfg.publicUrl}/api/${route}` } : {}),
            },
          ],
        }),
      );
    }
  }

  /**
   * Which price this request is held to. With a payment, the tier comes from the payer the signature commits to, so
   * only a real $WIF holder gets the holder price; a holder who signed the standard price (an unhinted quote) is
   * served at the standard price rather than refused. Without one, a `?payer=` / `X-Payer` hint only shapes the 402.
   */
  async function tierFor(route: Route, c: Context, signed: SignedPayment | null): Promise<Tier> {
    if (signed) {
      const best = await chain.tierOf(signed.payer);
      if (best === "holder" && signed.value === price(route, "standard")) return "standard";
      return best;
    }
    const hint = c.req.query("payer") ?? c.req.header("x-payer");
    if (hint && isAddress(hint)) return chain.tierOf(hint);
    return "standard";
  }

  /** $WIF back to whoever just paid; never fails the paid call */
  async function cashback(entryId: string, payer: string): Promise<string | null> {
    if (cfg.wif.cashback <= 0n) return null;
    const send = chain
      .sendWif(payer, cfg.wif.cashback)
      .then((t) => {
        store.updateLedger(entryId, { cashbackTx: t.tx });
        log(`cashback ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF -> ${payer}: ${t.tx}`);
        return t.tx;
      })
      .catch((e: unknown) => {
        store.updateLedger(entryId, { cashbackError: safeMessage(e) });
        log(`cashback to ${payer} failed: ${safeMessage(e)}`);
        return null;
      });
    const timeout = new Promise<"pending">((r) => setTimeout(() => r("pending"), cashbackWaitMs).unref?.());
    const r = await Promise.race([send, timeout]);
    return r === "pending" ? "pending" : r;
  }

  function paid(route: Route, validate: (body: unknown) => string | null, handle: (c: Context, input: string, ctx: PaidCtx) => Promise<Response>) {
    return async (c: Context) => {
      let body: unknown = null;
      try {
        body = await c.req.json();
      } catch {
        body = null;
      }
      // refuse bad input before the 402, so nobody pays for a request we would reject
      const input = validate(body);
      if (!input) return c.json({ error: `send JSON with a non-empty "${route === "ask" ? "question" : "request"}" of at most ${MAX_TEXT} characters` }, 400);
      if (route === "hire" && !cfg.workerToken) return c.json({ error: "hiring is off on this server: no WORKER_TOKEN, so nobody could take the task" }, 503);

      const header = paymentHeaderOf((n) => c.req.header(n));
      if (header.conflict) return c.json({ error: "send one payment header: PAYMENT-SIGNATURE and X-PAYMENT differ" }, 400);
      const signed = signedPayment(header.value);
      // a header the SDK cannot route (no `network`) makes its middleware throw a 500: refuse it as bad input
      if (header.value && !signed) return c.json({ error: "malformed payment header" }, 400);

      const tier = await tierFor(route, c, signed);
      const paywall = paywalls.get(`${route}:${tier}`)!;
      let response: Response | undefined;
      const result = await paywall(c as never, async () => {
        // the SDK settles before this runs: from here on the buyer has paid, so every exit carries the receipt
        const x402 = c.get("x402" as never) as X402State;
        const settled = await x402.settle();
        const ctx: PaidCtx = {
          tier,
          payer: signed!.payer,
          settleTx: settled.transactionHash ?? settled.transaction ?? null,
          price: price(route, tier),
          entryId: "",
        };
        try {
          ctx.entryId = store.addLedger({ kind: route, network: cfg.chain.caip2, payer: ctx.payer, tier, price: ctx.price.toString(), settleTx: ctx.settleTx, cashbackTx: null }).id;
          response = await handle(c, input, ctx);
        } catch (e) {
          log(`paid ${route} by ${ctx.payer} (${ctx.settleTx}) failed after settlement: ${safeMessage(e)}`);
          response = c.json({ error: `paid, but the call failed: ${safeMessage(e)}`, paid: true, receipt: receipt(ctx, null) }, 500);
        }
      });
      return response ?? (result as Response);
    };
  }

  interface PaidCtx {
    tier: Tier;
    payer: string;
    settleTx: string | null;
    price: bigint;
    entryId: string;
  }

  const receipt = (ctx: PaidCtx, cashbackTx: string | null) => ({
    network: cfg.chain.caip2,
    payer: ctx.payer,
    tier: ctx.tier,
    paid: `${formatUnits(ctx.price, USDG_DECIMALS)} USDG`,
    settleTx: ctx.settleTx,
    settleUrl: ctx.settleTx ? txUrl(cfg.chain, ctx.settleTx) : null,
    cashback:
      cfg.wif.cashback > 0n
        ? { amount: `${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF`, tx: cashbackTx, url: cashbackTx && cashbackTx !== "pending" ? txUrl(cfg.chain, cashbackTx) : null }
        : null,
  });

  app.use("/api/*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/info", (c) =>
    c.json({
      name: "Flat Fee",
      // the public RPC for the wallet's "add network", never RPC_URL (that one may be private or a local fork)
      network: { name: cfg.chain.name, label: cfg.chain.label, caip2: cfg.chain.caip2, chainId: cfg.chain.chainId, explorer: cfg.chain.explorer, rpcUrl: cfg.chain.rpcUrl },
      facilitator: cfg.facilitatorUrl,
      payTo: cfg.payTo,
      payToUrl: addressUrl(cfg.chain, cfg.payTo),
      usdg: cfg.chain.usdg,
      prices: {
        ask: { standard: formatUnits(cfg.prices.ask, USDG_DECIMALS), holder: formatUnits(cfg.prices.askHolder, USDG_DECIMALS) },
        hire: { standard: formatUnits(cfg.prices.hire, USDG_DECIMALS), holder: formatUnits(cfg.prices.hireHolder, USDG_DECIMALS) },
      },
      wif: {
        token: cfg.wif.token,
        holderMin: formatUnits(cfg.wif.holderMin, WIF_DECIMALS),
        cashback: formatUnits(cfg.wif.cashback, WIF_DECIMALS),
        workerReward: formatUnits(cfg.wif.workerReward, WIF_DECIMALS),
      },
    }),
  );

  app.get("/api/quote", async (c) => {
    const payer = c.req.query("payer");
    if (!payer || !isAddress(payer)) return c.json({ error: "pass ?payer=0x..." }, 400);
    const tier = await chain.tierOf(payer);
    return c.json({
      payer: getAddress(payer.toLowerCase()),
      tier,
      ask: formatUnits(price("ask", tier), USDG_DECIMALS),
      hire: formatUnits(price("hire", tier), USDG_DECIMALS),
    });
  });

  app.post(
    "/api/ask",
    paid(
      "ask",
      (b) => text(b, "question"),
      async (c, question, ctx) => {
        store.updateLedger(ctx.entryId, { question });
        let reply;
        try {
          reply = await answer(question, cfg, chain);
        } catch (e) {
          // the payment already settled: answer with what went wrong instead of a bare 500
          reply = { skill: "help", facts: {}, answer: `The agent could not read the chain just now (${safeMessage(e)}).` };
        }
        const cb = await cashback(ctx.entryId, ctx.payer);
        return c.json({ ...reply, receipt: receipt(ctx, cb) });
      },
    ),
  );

  app.post(
    "/api/hire",
    paid(
      "hire",
      (b) => text(b, "request"),
      async (c, request, ctx) => {
        const task = store.createTask({ request, payer: ctx.payer, paidTx: ctx.settleTx });
        store.updateLedger(ctx.entryId, { taskId: task.id });
        const cb = await cashback(ctx.entryId, ctx.payer);
        return c.json({ task, poll: `/api/tasks/${task.id}`, receipt: receipt(ctx, cb) }, 201);
      },
    ),
  );

  app.get("/api/ledger", (c) =>
    c.json(
      store.ledger(50).map((e) => ({
        ...e,
        price: formatUnits(BigInt(e.price), USDG_DECIMALS),
        settleUrl: e.settleTx ? txUrl(cfg.chain, e.settleTx) : null,
        cashbackUrl: e.cashbackTx ? txUrl(cfg.chain, e.cashbackTx) : null,
      })),
    ),
  );

  app.get("/api/tasks", (c) => c.json(store.tasks()));
  app.get("/api/tasks/:id", (c) => {
    const t = store.task(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "no such task" }, 404);
  });

  // the task board is closed without WORKER_TOKEN; the token is compared in constant time
  const workerAllowed = (c: Context) => {
    const got = c.req.header("x-worker-token");
    if (!cfg.workerToken || !got) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(cfg.workerToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  app.post("/api/tasks/:id/claim", async (c) => {
    if (!workerAllowed(c)) return c.json({ error: "wrong or missing X-Worker-Token" }, 401);
    const body = await c.req.json().catch(() => null);
    const worker = (body as { worker?: string } | null)?.worker;
    if (!worker || !isAddress(worker)) return c.json({ error: 'send {"worker": "0x..."}' }, 400);
    const t = store.task(c.req.param("id"));
    if (!t) return c.json({ error: "no such task" }, 404);
    if (t.status !== "open") return c.json({ error: `task is ${t.status}` }, 409);
    // whoever paid for a task cannot also take it and collect the $WIF reward on their own payment
    if (getAddress(worker.toLowerCase()) === t.payer) return c.json({ error: "the payer of a task cannot claim it" }, 409);
    return c.json(store.updateTask(t.id, { status: "claimed", worker: getAddress(worker.toLowerCase()) }));
  });

  app.post("/api/tasks/:id/complete", async (c) => {
    if (!workerAllowed(c)) return c.json({ error: "wrong or missing X-Worker-Token" }, 401);
    const body = await c.req.json().catch(() => null);
    const result = text(body, "answer");
    const worker = (body as { worker?: string } | null)?.worker;
    if (!result || !worker || !isAddress(worker)) return c.json({ error: 'send {"worker": "0x...", "answer": "..."}' }, 400);
    const t = store.task(c.req.param("id"));
    if (!t) return c.json({ error: "no such task" }, 404);
    if (t.status !== "claimed" || t.worker !== getAddress(worker.toLowerCase())) {
      return c.json({ error: "only the worker who claimed this task can complete it" }, 409);
    }
    store.updateTask(t.id, { status: "done", answer: result, doneAt: new Date().toISOString() });
    if (cfg.wif.workerReward > 0n) {
      try {
        const r = await chain.sendWif(t.worker, cfg.wif.workerReward);
        store.updateTask(t.id, { rewardTx: r.tx });
      } catch (e) {
        store.updateTask(t.id, { rewardError: safeMessage(e) });
      }
    }
    return c.json(store.task(t.id));
  });

  return app;
}
