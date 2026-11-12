// The HTTP app: the landing page, two x402-paid routes priced in USDG (ask an agent, hire a human), and the task board.
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isAddress, getAddress } from "ethers";
import { createHonoMiddleware, parsePaymentHeader } from "uvd-x402-sdk/backend";
import { answer } from "./agent.js";
import { WifTransferUnconfirmed, type Chain, type Tier } from "./chain.js";
import { USDG_DECIMALS, USDG_DOMAIN, WIF_DECIMALS, addressUrl, formatUnits, txUrl, type Config } from "./config.js";
import { hireExpiry, newEmState, publicEm, publicPause, type EmHire } from "./emhire.js";
import { buildProof, loadEvidence, type Evidence } from "./proof.js";
import type { Store, Task } from "./store.js";
import { budgetedWif } from "./wif.js";

export interface AppDeps {
  cfg: Config;
  chain: Chain;
  store: Store;
  /** milliseconds a paid response waits for its $WIF cashback before answering "pending" */
  cashbackWaitMs?: number;
  log?: (msg: string) => void;
  /** the clock of the daily $WIF budget */
  now?: () => Date;
  /** the x402 paywall factory; tests wrap it to play an SDK that lets an unsettled payment through */
  middleware?: typeof createHonoMiddleware;
  /** serving a local fork (npm run demo): the landing page then refuses to sign with a browser wallet */
  localFork?: boolean;
  /** EM_HIRE=on: the driver that runs each hire on Execution Market (src/emhire.ts); required then, refused otherwise */
  emHire?: EmHire | null;
  /** milliseconds a paid hire waits for its publish on Execution Market before answering with the task as it stands */
  publishWaitMs?: number;
  /** the dated reads on chain behind GET /api/proof (src/proof.ts); by default docs/evidence, null for none */
  evidence?: Evidence | null;
}

type Route = "ask" | "hire";

const MAX_TEXT = 500;

interface X402State {
  settle: () => Promise<{ success: boolean; transactionHash?: string; transaction?: string; payer?: string; replayed?: boolean }>;
  verifyResult: { payer?: string };
  payment: unknown;
}

/**
 * The one payment header the price is picked from: PAYMENT-SIGNATURE, else X-PAYMENT. Two different payment headers
 * in one request are refused outright, so a decoy in one header can never pick the price while the other one pays.
 * The SDK middleware (uvd-x402-sdk 2.114.0, readPaymentHeaders) pays only from one value: it reads both headers,
 * trimmed, and answers 400 itself when they differ, when one is present but empty, or when the value does not parse.
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
  /** `${payer}:${nonce}`: one EIP-3009 authorization, which is served at most once */
  authorization: string;
}

/** what a payment header commits to: the payer, the amount, the network and the nonce; null when it is not routable */
export function signedPayment(value: string | null): SignedPayment | null {
  if (!value) return null;
  const p = parsePaymentHeader(value) as { network?: unknown; payload?: { authorization?: { from?: string; value?: string; nonce?: string } } } | null;
  const from = p?.payload?.authorization?.from;
  const nonce = p?.payload?.authorization?.nonce;
  if (!p || typeof p.network !== "string" || typeof from !== "string" || !isAddress(from)) return null;
  if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) return null;
  let amount: bigint | null = null;
  try {
    amount = BigInt(p.payload?.authorization?.value ?? "");
  } catch {
    amount = null;
  }
  const payer = getAddress(from.toLowerCase());
  return { payer, value: amount, network: p.network, authorization: `${payer}:${nonce.toLowerCase()}` };
}

/**
 * An error's message without URLs: ethers puts the RPC URL (and any API key in it) into `info.requestUrl`. `secrets`
 * (the configured RPC URL) are removed too, plain and JSON-escaped, wherever they appear.
 */
export function safeMessage(e: unknown, secrets: (string | null | undefined)[] = []): string {
  const err = e as { shortMessage?: string; message?: string } | null;
  let m = err?.shortMessage ?? err?.message ?? String(e);
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of [secret, secret.replaceAll("/", "\\/"), secret.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")]) {
      if (form) m = m.split(form).join("[rpc]");
    }
  }
  return m.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").slice(0, 200);
}

function text(body: unknown, key: string): string | null {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= MAX_TEXT ? t : null;
}

export function createApp({
  cfg,
  chain,
  store,
  cashbackWaitMs = 15_000,
  log = console.log,
  now = () => new Date(),
  middleware = createHonoMiddleware,
  localFork = false,
  emHire = null,
  publishWaitMs = 10_000,
  evidence = loadEvidence(),
}: AppDeps) {
  const app = new Hono();
  // GET /api/proof counts this server's own settlements from here on, on top of the dated reads
  const startedAt = now().toISOString();
  const redact = (e: unknown) => safeMessage(e, [cfg.rpcUrl]);
  // EM_HIRE=on without the driver would take money for tasks nobody publishes: refuse to start instead
  if (cfg.em && !emHire) throw new Error("EM_HIRE=on needs the Execution Market driver (createEmHire)");
  if (!cfg.em && emHire) throw new Error("an Execution Market driver was given but EM_HIRE is off");

  // $WIF out of the merchant wallet, inside the daily budget (src/wif.ts)
  const sendWifBudgeted = budgetedWif(cfg, chain, store, now);
  const price = (route: Route, tier: Tier) =>
    route === "ask" ? (tier === "holder" ? cfg.prices.askHolder : cfg.prices.ask) : tier === "holder" ? cfg.prices.hireHolder : cfg.prices.hire;

  const descriptions: Record<Route, string> = {
    ask: `Ask the Flat Fee agent a question about ${cfg.chain.label}`,
    hire: emHire ? "Hire a human for a small task through Flat Fee, on Execution Market" : "Hire a human for a small task through Flat Fee",
  };

  // one paywall per (route, tier): the tier only ever lowers the price, and it is read from the signed payer
  const paywalls = new Map<string, ReturnType<typeof createHonoMiddleware>>();
  for (const route of ["ask", "hire"] as const) {
    for (const tier of ["standard", "holder"] as const) {
      paywalls.set(
        `${route}:${tier}`,
        middleware({
          facilitatorUrl: cfg.facilitatorUrl,
          // the SDK's default, written down: the payment settles before the handler runs, or the handler never runs
          settlementStrategy: "before-handler",
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
    const send = sendWifBudgeted(payer, cfg.wif.cashback)
      .then((t) => {
        store.updateLedger(entryId, { cashbackTx: t.tx });
        log(`cashback ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF -> ${payer}: ${t.tx}`);
        return t.tx;
      })
      .catch((e: unknown) => {
        // broadcast but not seen mined: keep the hash, it may still land
        const tx = e instanceof WifTransferUnconfirmed ? e.tx : null;
        store.updateLedger(entryId, { cashbackTx: tx, cashbackError: redact(e) });
        log(`cashback to ${payer} failed: ${redact(e)}`);
        return tx;
      });
    const timeout = new Promise<"pending">((r) => setTimeout(() => r("pending"), cashbackWaitMs).unref?.());
    const r = await Promise.race([send, timeout]);
    return r === "pending" ? "pending" : r;
  }

  function paid(route: Route, validate: (body: unknown) => string | null, handle: (c: Context, input: string, ctx: PaidCtx) => Promise<Response>) {
    return async (c: Context) => {
      // read a copy: the SDK reads the raw body again to check an X-UVD-Purchase context
      let body: unknown = null;
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = null;
      }
      // refuse bad input before the 402, so nobody pays for a request we would reject
      const input = validate(body);
      if (!input) return c.json({ error: `send JSON with a non-empty "${route === "ask" ? "question" : "request"}" of at most ${MAX_TEXT} characters` }, 400);
      if (route === "hire" && !emHire && !cfg.workerToken) return c.json({ error: "hiring is off on this server: no WORKER_TOKEN, so nobody could take the task" }, 503);
      // through Execution Market, a request EM's own rules would refuse to publish is refused here, before anyone pays
      const unpublishable = route === "hire" ? (emHire?.refuses(input) ?? null) : null;
      if (unpublishable) return c.json({ error: unpublishable }, 400);
      // through Execution Market, a hire that could not be published or funded is refused before anyone pays for it
      const paused = route === "hire" ? (emHire?.unavailable() ?? null) : null;
      // the same fixed sentence /api/info shows: anyone can ask without paying, so EM's words, the merchant wallet and
      // the amounts of the detail stay off the wire (EM's refusals and escrow problems are logged when they begin)
      if (paused) {
        const reason = publicPause(paused.kind, cfg.chain.label);
        return c.json({ error: `hiring is paused: ${reason}`, paused: { kind: paused.kind, reason }, retryable: true }, 503);
      }

      const header = paymentHeaderOf((n) => c.req.header(n));
      if (header.conflict) return c.json({ error: "send one payment header: PAYMENT-SIGNATURE and X-PAYMENT differ" }, 400);
      const signed = signedPayment(header.value);
      // a header the SDK cannot route (no `network`) is bad input: refused here, before the price is picked from it
      if (header.value && !signed) return c.json({ error: "malformed payment header" }, 400);

      const tier = await tierFor(route, c, signed);
      const paywall = paywalls.get(`${route}:${tier}`)!;
      let response: Response | undefined;
      const result = await paywall(c as never, async () => {
        // the SDK settles before this runs: from here on the buyer has paid, so every exit carries the receipt
        const x402 = c.get("x402" as never) as X402State;
        const settled = await x402.settle();
        // the paywall refuses an unsettled payment before this point; if it ever let one through, serve nothing
        if (!settled.success) {
          log(`unsettled payment reached the ${route} handler (${signed!.payer}); nothing served`);
          response = c.json({ error: "the payment did not settle, so nothing was served", retryable: false }, 502);
          return;
        }
        const settleTx = settled.transactionHash ?? settled.transaction ?? null;
        // Only a NEW settlement is served. A resend bound with X-UVD-Purchase comes back from the facilitator as the
        // original success, marked replayed; it is never served or paid back again, whatever this server's disk
        // remembers (on Lightsail, every restart starts with an empty DATA_DIR).
        if (settled.replayed) {
          response = c.json({ error: "this payment was already settled for an earlier request; it is not served again", paid: true, settleTx }, 409);
          return;
        }
        // second layer, for a facilitator that would not mark the replay: the ledger serves one authorization once.
        // The check and the ledger entry below happen with no await in between.
        const earlier = store.servedFor(signed!.authorization);
        if (earlier) {
          response = c.json({ error: "this payment was already served", paid: true, settleTx: earlier.settleTx, entry: earlier.id }, 409);
          return;
        }
        const ctx: PaidCtx = {
          tier,
          payer: signed!.payer,
          settleTx,
          price: price(route, tier),
          entryId: "",
        };
        try {
          ctx.entryId = store.addLedger({
            kind: route,
            network: cfg.chain.caip2,
            payer: ctx.payer,
            tier,
            price: ctx.price.toString(),
            settleTx,
            cashbackTx: null,
            authorization: signed!.authorization,
          }).id;
          response = await handle(c, input, ctx);
        } catch (e) {
          // the detail (paths, ids) stays in the server log; the buyer gets a fixed message and the proof of payment
          log(`paid ${route} by ${ctx.payer} (${ctx.settleTx}) failed after settlement: ${redact(e)}`);
          response = c.json({ error: "paid, but the call failed on our side; keep this receipt", paid: true, receipt: receipt(ctx, null) }, 500);
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

  // a task as the public sees it: a board task as it is, an Execution Market one without its signed escrows
  const view = (t: Task) => (t.em ? { ...t, em: publicEm(t.em) } : t);

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
      localFork,
      // the public RPC for the wallet's "add network", never RPC_URL (that one may be private or a local fork)
      network: { name: cfg.chain.name, label: cfg.chain.label, caip2: cfg.chain.caip2, chainId: cfg.chain.chainId, explorer: cfg.chain.explorer, rpcUrl: cfg.chain.publicRpcUrl },
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
      // who does a hire: Flat Fee's own board, or a human on Execution Market paid from a USDG escrow. Through
      // Execution Market, whether a hire would be taken right now (the same check as the 503 before the 402), and if
      // not, why, in a fixed sentence per kind (publicPause): the 503's detail can carry EM's words, a wallet or an amount
      hire: cfg.em ? { via: "execution-market", bounty: formatUnits(cfg.em.bounty, USDG_DECIMALS), deadlineHours: cfg.em.deadlineHours, ...hireAvailability() } : { via: "board" },
    }),
  );

  function hireAvailability() {
    const p = emHire!.unavailable();
    return {
      available: p === null,
      paused: p ? { kind: p.kind, reason: publicPause(p.kind, cfg.chain.label) } : null,
      // what becomes of a hire nobody finishes, before anyone pays for one
      expiry: hireExpiry(cfg.em!.deadlineHours),
    };
  }

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
          reply = { skill: "help", facts: {}, answer: `The agent could not read the chain just now (${redact(e)}).` };
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
        if (emHire) {
          // Execution Market: the task is published there now (or by the loop, if EM is slow), and the answer comes
          // back on the poll link once a worker delivered and Flat Fee approved it
          const task = store.createTask({ request, payer: ctx.payer, paidTx: ctx.settleTx, via: "em", em: newEmState(now()) });
          store.updateLedger(ctx.entryId, { taskId: task.id });
          const published = emHire.publish(task.id);
          const wait = new Promise<void>((r) => setTimeout(r, publishWaitMs).unref?.());
          const [, cb] = await Promise.all([Promise.race([published, wait]), cashback(ctx.entryId, ctx.payer)]);
          return c.json({ task: view(store.task(task.id)!), via: "execution-market", poll: `/api/tasks/${task.id}`, expiry: hireExpiry(cfg.em!.deadlineHours), receipt: receipt(ctx, cb) }, 201);
        }
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

  // what the landing page shows as proof: every figure with its transactions (src/proof.ts)
  app.get("/api/proof", (c) => c.json(buildProof(cfg, evidence, store.ledger(Number.MAX_SAFE_INTEGER), store.tasks(), startedAt, { localFork })));

  app.get("/api/tasks", (c) => c.json(store.tasks().map(view)));
  app.get("/api/tasks/:id", (c) => {
    const t = store.task(c.req.param("id"));
    return t ? c.json(view(t)) : c.json({ error: "no such task" }, 404);
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
    if (t.via === "em") return c.json({ error: "this task runs on Execution Market: take it there" }, 409);
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
    if (t.via === "em") return c.json({ error: "this task runs on Execution Market: deliver it there" }, 409);
    if (t.status !== "claimed" || t.worker !== getAddress(worker.toLowerCase())) {
      return c.json({ error: "only the worker who claimed this task can complete it" }, 409);
    }
    store.updateTask(t.id, { status: "done", answer: result, doneAt: new Date().toISOString() });
    if (cfg.wif.workerReward > 0n) {
      try {
        const r = await sendWifBudgeted(t.worker, cfg.wif.workerReward);
        store.updateTask(t.id, { rewardTx: r.tx });
      } catch (e) {
        store.updateTask(t.id, { rewardTx: e instanceof WifTransferUnconfirmed ? e.tx : null, rewardError: redact(e) });
      }
    }
    return c.json(store.task(t.id));
  });

  return app;
}
