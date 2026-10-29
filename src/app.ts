// The HTTP app: the landing page, two x402-paid routes priced in USDG (ask an agent, hire a human), and the task board.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isAddress, getAddress } from "ethers";
import { createHonoMiddleware, extractPaymentFromHeaders } from "uvd-x402-sdk/backend";
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

/** the payer and the amount an X-PAYMENT (or PAYMENT-SIGNATURE) header commits to, or null */
export function signedPayment(headers: Record<string, string | undefined>): { payer: string; value: bigint | null } | null {
  const p = extractPaymentFromHeaders(headers) as { payload?: { authorization?: { from?: string; value?: string } } } | null;
  const from = p?.payload?.authorization?.from;
  if (typeof from !== "string" || !isAddress(from)) return null;
  let value: bigint | null = null;
  try {
    value = BigInt(p?.payload?.authorization?.value ?? "");
  } catch {
    value = null;
  }
  return { payer: getAddress(from.toLowerCase()), value };
}

export const payerFromHeaders = (headers: Record<string, string | undefined>) => signedPayment(headers)?.payer ?? null;

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

  const headersOf = (c: Context) => {
    const h: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => (h[k] = v));
    return h;
  };

  /**
   * Which price this request is held to. With a payment, the tier comes from the payer the signature commits to, so
   * only a real $WIF holder gets the holder price; a holder who signed the standard price (an unhinted quote) is
   * served at the standard price rather than refused. Without one, a `?payer=` / `X-Payer` hint only shapes the 402.
   */
  async function tierFor(route: Route, c: Context): Promise<Tier> {
    const signed = signedPayment(headersOf(c));
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
      .catch((e: Error) => {
        store.updateLedger(entryId, { cashbackError: e.message.slice(0, 200) });
        log(`cashback to ${payer} failed: ${e.message}`);
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

      // a payment header the SDK cannot route (no `network`) makes its middleware throw a 500: refuse it as bad input
      const raw = extractPaymentFromHeaders(headersOf(c)) as { network?: unknown } | null;
      const sent = c.req.header("x-payment") ?? c.req.header("payment-signature");
      if (sent && (!raw || typeof raw.network !== "string")) return c.json({ error: "malformed X-PAYMENT header" }, 400);

      const tier = await tierFor(route, c);
      const paywall = paywalls.get(`${route}:${tier}`)!;
      let response: Response | undefined;
      const result = await paywall(c as never, async () => {
        const x402 = c.get("x402" as never) as X402State;
        const settled = await x402.settle();
        const settleTx = settled.transactionHash ?? settled.transaction ?? null;
        const payer = getAddress(String(settled.payer ?? x402.verifyResult.payer ?? payerFromHeaders(headersOf(c))).toLowerCase());
        response = await handle(c, input, { tier, payer, settleTx, price: price(route, tier) });
      });
      return response ?? (result as Response);
    };
  }

  interface PaidCtx {
    tier: Tier;
    payer: string;
    settleTx: string | null;
    price: bigint;
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
        const entry = store.addLedger({ kind: "ask", network: cfg.chain.caip2, payer: ctx.payer, tier: ctx.tier, price: ctx.price.toString(), settleTx: ctx.settleTx, cashbackTx: null, question });
        let reply;
        try {
          reply = await answer(question, cfg, chain);
        } catch (e) {
          // the payment already settled: answer with what went wrong instead of a bare 500
          reply = { skill: "help", facts: {}, answer: `The agent could not read the chain just now (${(e as Error).message}).` };
        }
        const cb = await cashback(entry.id, ctx.payer);
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
        const entry = store.addLedger({ kind: "hire", network: cfg.chain.caip2, payer: ctx.payer, tier: ctx.tier, price: ctx.price.toString(), settleTx: ctx.settleTx, cashbackTx: null, taskId: task.id });
        const cb = await cashback(entry.id, ctx.payer);
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

  const workerAllowed = (c: Context) => !cfg.workerToken || c.req.header("x-worker-token") === cfg.workerToken;

  app.post("/api/tasks/:id/claim", async (c) => {
    if (!workerAllowed(c)) return c.json({ error: "wrong or missing X-Worker-Token" }, 401);
    const body = await c.req.json().catch(() => null);
    const worker = (body as { worker?: string } | null)?.worker;
    if (!worker || !isAddress(worker)) return c.json({ error: 'send {"worker": "0x..."}' }, 400);
    const t = store.task(c.req.param("id"));
    if (!t) return c.json({ error: "no such task" }, 404);
    if (t.status !== "open") return c.json({ error: `task is ${t.status}` }, 409);
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
        store.updateTask(t.id, { rewardError: (e as Error).message.slice(0, 200) });
      }
    }
    return c.json(store.task(t.id));
  });

  return app;
}
