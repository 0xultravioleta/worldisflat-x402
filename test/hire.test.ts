// `npm run e2e:hire` (scripts/lib/hire.ts) against doubles: no network, no credentials, no RPC. The run is the real
// one (the rules, the payment, the follow-up, the worker's application and delivery, the checks on chain), and so is
// the Flat Fee it buys from: createApp with EM_HIRE on, the Execution Market driver, its ERC-8128 client and the SDK's
// own escrow builder on Robinhood Chain mainnet (EM's recorded payment-config, test/fixtures). Execution Market is a
// double that checks every ERC-8128 signature (the merchant's and the worker's) with the SDK's verifier and the escrow
// authorization the way the facilitator would; a fake chain moves the balances every step would move on mainnet.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet, getAddress, verifyTypedData, type JsonRpcProvider } from "ethers";
import { ESCROW_PAYMENT_INFO_TYPEHASH, computeEscrowNonce } from "uvd-x402-sdk";
import { policyFromPreset, verifyRequest, type NonceStore } from "uvd-x402-sdk/erc8128";
import { createApp } from "../src/app.js";
import type { Chain, Tier } from "../src/chain.js";
import { CHAINS, loadConfig, type Config, type EmConfig } from "../src/config.js";
import { emClient, type Fetch } from "../src/em.js";
import { createEmHire, hireExpiry } from "../src/emhire.js";
import { escrowPaymentAuth, escrowReadiness, releaseOrder } from "../src/escrow.js";
import { Store } from "../src/store.js";
import { budgetedWif } from "../src/wif.js";
import { EmWorkerError, emWorker } from "../scripts/lib/emworker.js";
import { hirePlanRefusal, origin, publishHint, remoteHireRefusal, rpcRefusal, runHire, type HireDeps, type HirePlan } from "../scripts/lib/hire.js";
// @ts-expect-error plain JS module shared with the browser
import { paymentHeader, typedDataFor } from "../public/x402-browser.js";

type Any = Record<string, any>;
const RECORDED: Any = JSON.parse(readFileSync(new URL("./fixtures/em-payment-config.json", import.meta.url), "utf8"));
const RH = RECORDED.escrow.networks.robinhood;
const USDG = CHAINS.robinhood.usdg;
const WIF_TOKEN = CHAINS.robinhood.wif!;
const U = 10n ** 6n; // one USDG
const W = 10n ** 18n; // one $WIF
const RECEIVE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
const hash = () => "0x" + randomBytes(32).toString("hex");

const servers: { close: () => void }[] = [];
const dirs: string[] = [];
let nextPort = 36500 + Math.floor(Math.random() * 400);
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------- the chain
/** USDG and $WIF balances, moved by the facilitator, the escrow and the merchant's $WIF transfers */
class Ledger {
  usdg = new Map<string, bigint>();
  wif = new Map<string, bigint>();
  private key = (a: string) => a.toLowerCase();
  get(m: Map<string, bigint>, a: string) {
    return m.get(this.key(a)) ?? 0n;
  }
  move(m: Map<string, bigint>, from: string, to: string, amount: bigint) {
    if (this.get(m, from) < amount) throw new Error("insufficient balance");
    m.set(this.key(from), this.get(m, from) - amount);
    m.set(this.key(to), this.get(m, to) + amount);
  }
}

// ------------------------------------------------------------------------------------------------- Execution Market
function emDouble(ledger: Ledger) {
  const issued = new Set<string>();
  const used = new Set<string>();
  const nonceStore: NonceStore = {
    consume(n) {
      if (!issued.has(n)) return "unknown";
      if (used.has(n)) return "replayed";
      used.add(n);
      return "ok";
    },
  };
  const policy = policyFromPreset("em-lenient", { authority: "em.test", nonceStore });
  const st = {
    tasks: new Map<string, Any>(),
    apps: new Map<string, Any[]>(),
    subs: new Map<string, Any[]>(),
    executors: new Map<string, string>(),
    /** a dashboard session: token -> wallet */
    sessions: new Map<string, string>(),
    /** the client value the operator approved for the test worker */
    approvedClient: null as string | null,
    /** every publish, as Flat Fee sent it */
    creates: [] as Any[],
    /** EM refuses reputation_network: robinhood at publish, as its route does with that network turned off */
    refuseReputation: false,
    cancels: [] as string[],
    /** the approval answers without its payment_tx (Flat Fee then has none; the task on EM has it) */
    approveWithoutTx: false,
    calls: [] as { method: string; path: string; wallet: string; as: string }[],
    applies: [] as { taskId: string; wallet: string; type: string }[],
  };
  const executorOf = (wallet: string) => {
    const k = wallet.toLowerCase();
    if (!st.executors.has(k)) st.executors.set(k, randomUUID());
    return st.executors.get(k)!;
  };
  const app = new Hono<{ Variables: { wallet: string; type: string; kind: string } }>();
  app.get("/api/v1/auth/erc8128/nonce", (c) => {
    const n = randomBytes(16).toString("hex");
    issued.add(n);
    return c.json({ nonce: n, ttl_seconds: 300 });
  });
  app.get("/api/v1/h2a/payment-config", (c) => c.json(RECORDED));
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/auth/erc8128/nonce" || c.req.path === "/api/v1/h2a/payment-config") return next();
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (bearer) {
      const wallet = st.sessions.get(bearer);
      if (!wallet) return c.json({ error: "unauthorized" }, 401);
      c.set("wallet", wallet);
      c.set("type", "human");
      c.set("kind", "human");
    } else {
      const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
      const v = await verifyRequest({ method: c.req.method, url: c.req.url, headers: Object.fromEntries(c.req.raw.headers), rawBody: bytes.length ? bytes : undefined }, policy);
      if (!v.ok) return c.json({ error: v.code, message: v.message }, v.status as 401);
      c.set("wallet", getAddress(v.wallet));
      const viaAgent = st.approvedClient !== null && c.req.header("x-em-client")?.toLowerCase() === st.approvedClient;
      c.set("type", viaAgent ? "human_via_agent" : "agent");
      c.set("kind", viaAgent ? "human_via_agent" : "autonomous_agent");
    }
    st.calls.push({ method: c.req.method, path: c.req.path, wallet: c.get("wallet"), as: c.get("type") });
    return next();
  });
  const own = (c: any, id: string) => {
    const t = st.tasks.get(id);
    return t && t.agent_id === c.get("wallet") ? t : null;
  };
  // the publisher
  app.post("/api/v1/tasks", async (c) => {
    const body = await c.req.json();
    st.creates.push(body);
    if (st.refuseReputation && body.reputation_network === "robinhood") {
      return c.json({ detail: { error: "invalid_reputation_network", code: "INVALID_REPUTATION_NETWORK", message: "robinhood cannot hold ERC-8004 reputation. Valid networks: base" } }, 422);
    }
    const id = randomUUID();
    const t = { id, status: "published", title: body.title, bounty_usd: body.bounty_usd, payment_network: body.payment_network, payment_token: body.payment_token, deadline: new Date(Date.now() + body.deadline_hours * 3_600_000).toISOString(), agent_id: c.get("wallet"), escrow_tx: null as string | null, payment_tx: null as string | null, executor_id: null as string | null, escrow_status: "pending_assignment", worker_wallet: null as string | null };
    st.tasks.set(id, t);
    st.apps.set(id, []);
    st.subs.set(id, []);
    return c.json(t, 201);
  });
  app.get("/api/v1/tasks/:id", (c) => {
    // the publisher, or a participant: an applicant or the assigned executor (tasks.py get_task)
    const t = st.tasks.get(c.req.param("id"));
    const participant = t && st.apps.get(t.id)!.some((a) => a.wallet_address === c.get("wallet"));
    return t && (t.agent_id === c.get("wallet") || participant) ? c.json(t) : c.json({ error: "TASK_NOT_FOUND" }, 404);
  });
  app.get("/api/v1/tasks/:id/applications", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN" }, 403);
    return c.json({ applications: st.apps.get(t.id), count: st.apps.get(t.id)!.length });
  });
  app.post("/api/v1/tasks/:id/assign", async (c) => {
    const t = own(c, c.req.param("id"));
    if (!t || t.status !== "published") return c.json({ error: "TASK_NOT_ASSIGNABLE" }, 409);
    const { executor_id } = await c.req.json();
    const applicant = st.apps.get(t.id)!.find((a) => a.executor_id === executor_id);
    const auth = JSON.parse(c.req.header("x-payment-auth") ?? "null");
    const a = auth?.payload?.authorization;
    const pi = auth?.payload?.paymentInfo;
    const bounty = BigInt(Math.round(t.bounty_usd * 1e6));
    // what the facilitator checks before it locks, on mainnet: the publisher's ReceiveWithAuthorization of the bounty
    // to the token collector, whose nonce commits to the applicant as receiver
    const ok =
      auth?.scheme === "escrow" &&
      !!applicant &&
      getAddress(verifyTypedData({ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG }, { ReceiveWithAuthorization: RECEIVE }, a, auth.payload.signature)) === c.get("wallet") &&
      getAddress(a.to) === getAddress(RH.token_collector) &&
      a.value === bounty.toString() &&
      getAddress(pi.receiver) === getAddress(applicant.wallet_address) &&
      a.nonce === computeEscrowNonce(4663, RH.escrow, ESCROW_PAYMENT_INFO_TYPEHASH, pi);
    if (!ok) return c.json({ detail: { error: "escrow_lock_failed", code: "INVALID_SIGNATURE" } }, 402);
    ledger.move(ledger.usdg, c.get("wallet"), RH.escrow, bounty);
    Object.assign(t, { status: "accepted", executor_id, worker_wallet: applicant.wallet_address, escrow_status: "locked", escrow_tx: hash() });
    return c.json({ success: true, data: { task_id: t.id, executor_id, status: "accepted", worker_wallet: applicant.wallet_address } });
  });
  app.get("/api/v1/tasks/:id/submissions", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN" }, 403);
    const subs = st.subs.get(t.id)!.map((s) => ({ ...s, evidence: null, evidence_manifest: { items: [{ field: "text_response", type: "text", size_bytes: Buffer.byteLength(s.evidence.text_response) }] } }));
    return c.json({ submissions: subs });
  });
  const sub = (id: string) => [...st.subs.values()].flat().find((s) => s.id === id);
  app.post("/api/v1/submissions/:sid/evidence/open", (c) => {
    const s = sub(c.req.param("sid"));
    if (!s || !own(c, s.task_id)) return c.json({ error: "FORBIDDEN" }, 403);
    return c.json({ evidence: s.evidence, notes: null });
  });
  app.post("/api/v1/submissions/:sid/approve", (c) => {
    const s = sub(c.req.param("sid"));
    if (!s || !own(c, s.task_id)) return c.json({ error: "FORBIDDEN" }, 403);
    const t = st.tasks.get(s.task_id)!;
    const bounty = BigInt(Math.round(t.bounty_usd * 1e6));
    const fee = (bounty * 1300n) / 10_000n; // fee_pct 0.13, taken from the bounty at release
    ledger.move(ledger.usdg, RH.escrow, t.worker_wallet, bounty - fee);
    ledger.move(ledger.usdg, RH.escrow, RECORDED.treasury, fee);
    Object.assign(s, { status: "accepted", agent_verdict: "accepted" });
    Object.assign(t, { status: "completed", escrow_status: "released", payment_tx: hash() });
    return c.json(st.approveWithoutTx ? { success: true, data: {} } : { success: true, data: { payment_tx: t.payment_tx } });
  });
  // the worker
  app.post("/api/v1/tasks/:id/apply", async (c) => {
    const t = st.tasks.get(c.req.param("id"));
    if (!t) return c.json({ error: "TASK_NOT_FOUND" }, 404);
    if (t.agent_id === c.get("wallet")) return c.json({ detail: "You published this task — you cannot apply to your own task" }, 403);
    const body = await c.req.json().catch(() => ({}));
    if (Object.keys(body).some((k) => !["executor_id", "message", "reputation_network"].includes(k))) return c.json({ error: "validation" }, 422);
    st.applies.push({ taskId: t.id, wallet: c.get("wallet"), type: c.get("type") });
    const row = { id: randomUUID(), task_id: t.id, executor_id: executorOf(c.get("wallet")), status: "pending", created_at: new Date().toISOString(), wallet_address: c.get("wallet"), effective_reputation_score: 0, review: null, executor_type: c.get("type"), executor_kind: c.get("kind") };
    st.apps.get(t.id)!.push(row);
    return c.json({ success: true, data: { application_id: row.id } }, 201);
  });
  app.post("/api/v1/tasks/:id/submit", async (c) => {
    const t = st.tasks.get(c.req.param("id"));
    if (!t || t.executor_id !== executorOf(c.get("wallet"))) return c.json({ error: "NOT_ASSIGNED" }, 403);
    if (!["accepted", "in_progress"].includes(t.status)) return c.json({ error: "TASK_NOT_SUBMITTABLE", message: t.status }, 409);
    const { evidence } = await c.req.json();
    if (typeof evidence?.text_response !== "string") return c.json({ error: "missing_evidence" }, 422);
    st.subs.get(t.id)!.push({ id: randomUUID(), task_id: t.id, executor_id: t.executor_id, status: "pending", agent_verdict: null, submitted_at: new Date().toISOString(), evidence });
    t.status = "submitted";
    return c.json({ success: true }, 201);
  });

  app.post("/api/v1/tasks/:id/cancel", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN" }, 403);
    // only a task nobody was assigned (nothing locked), or one whose escrow already went back
    if (t.status !== "published" && t.escrow_status !== "refunded") return c.json({ detail: { code: "TASK_NOT_CANCELLABLE" } }, 409);
    t.status = "cancelled";
    st.cancels.push(t.id);
    return c.json({ success: true });
  });

  const fetch: Fetch = (url, init = {}) => Promise.resolve(app.fetch(new Request(url, init)));
  return {
    st,
    fetch,
    /** another person applies, ranked above anyone new */
    /** the deadline passes on an assigned task with no delivery: EM expires it and refunds the escrow to the publisher */
    expire(taskId: string) {
      const t = st.tasks.get(taskId)!;
      const bounty = BigInt(Math.round(t.bounty_usd * 1e6));
      ledger.move(ledger.usdg, RH.escrow, t.agent_id, bounty);
      Object.assign(t, { status: "expired", escrow_status: "refunded", refund_tx: hash() });
    },
    stranger(taskId: string, wallet: string) {
      st.apps.get(taskId)!.push({ id: randomUUID(), task_id: taskId, executor_id: executorOf(wallet), status: "pending", created_at: new Date().toISOString(), wallet_address: wallet, effective_reputation_score: 90, review: null, executor_type: "human", executor_kind: "human" });
    },
  };
}

// ------------------------------------------------------------------------------------------------- the world
const merchant = Wallet.createRandom();
const buyer = Wallet.createRandom();
const workerWallet = Wallet.createRandom();
const sessionToken = "sess-42";
// the operator's .env on the machine that runs the e2e: as for e2e:mainnet, plus the private RPC
const RUN_ENV: Record<string, string> = {
  NETWORK: "robinhood",
  PAY_TO: merchant.address,
  RPC_URL: "https://private-rpc.example/robinhood/0123456789abcdef",
  WIF_CASHBACK: "10",
  MERCHANT_PRIVATE_KEY: merchant.privateKey,
  FLATFEE_URL: "https://flatfee.example",
  EM_API_URL: "https://em.test",
  CONFIRM_MAINNET_SPEND: "0.25",
  CONFIRM_MAINNET_BOUNTY: "0.20",
  CONFIRM_MAINNET_REWARD: "50",
  CONFIRM_MAINNET_WIF: "10",
  WORKER_MODE: "token",
  WORKER_WALLET: workerWallet.address,
  WORKER_EM_TOKEN: sessionToken,
};
const runCfg = () => loadConfig(RUN_ENV);
const planOf = (env: Record<string, string | undefined> = RUN_ENV): HirePlan => {
  const p = hirePlanRefusal(loadConfig({ ...RUN_ENV, ...env }), env, buyer.address);
  assert.ok("plan" in p, "refusal" in p ? p.refusal : "");
  return p.plan;
};

let facUrl = "";
const ledgers: Ledger[] = [];
before(() => {
  // the x402 facilitator: settles each authorization once, moving the buyer's USDG to PAY_TO
  const spent = new Set<string>();
  const fac = new Hono();
  fac.post("/verify", async (c) => c.json({ isValid: true, payer: (await c.req.json()).paymentPayload.payload.authorization.from }));
  fac.post("/settle", async (c) => {
    const b = await c.req.json();
    const a = b.paymentPayload.payload.authorization;
    if (spent.has(a.nonce)) return c.json({ success: false, errorReason: "authorization_already_used", network: "eip155:4663" });
    spent.add(a.nonce);
    for (const l of ledgers) if (l.get(l.usdg, a.from) >= BigInt(a.value)) l.move(l.usdg, a.from, a.to, BigInt(a.value));
    return c.json({ success: true, transaction: hash(), network: "eip155:4663", payer: a.from });
  });
  const port = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port }));
  facUrl = `http://127.0.0.1:${port}`;
});

/** a Flat Fee with EM_HIRE on (the deploy's shape, on mainnet), Execution Market's double, and the run's deps */
function world(opts: { workerAuth?: "token" | "erc8128"; approvedClient?: string | null; payTo?: string; slowReward?: boolean } = {}) {
  const payTo = opts.payTo ?? merchant.address;
  // the worker's $WIF is mined a while after Flat Fee marked the task done (src/emhire.ts finish): held until a later wait
  let heldReward: (() => void) | null = null;
  const ledger = new Ledger();
  ledgers.length = 0;
  ledgers.push(ledger);
  ledger.usdg.set(buyer.address.toLowerCase(), 588_716n);
  ledger.wif.set(buyer.address.toLowerCase(), 1026n * W);
  ledger.usdg.set(merchant.address.toLowerCase(), 1_069_850n);
  ledger.wif.set(merchant.address.toLowerCase(), 1034n * W);
  const em = emDouble(ledger);
  em.st.sessions.set(sessionToken, workerWallet.address);
  em.st.approvedClient = opts.approvedClient ?? null;
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-hire-e2e-"));
  dirs.push(dir);
  const loaded = loadConfig({
    NETWORK: "robinhood",
    PAY_TO: payTo,
    FACILITATOR_URL: facUrl,
    DATA_DIR: dir,
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: merchant.privateKey,
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    EM_ESCROW_ADDRESS: RH.escrow,
    EM_OPERATOR_ADDRESS: RH.operator,
    EM_TOKEN_COLLECTOR_ADDRESS: RH.token_collector,
    EM_REPUTATION_NETWORK: "robinhood",
  });
  const cfg = { ...loaded, em: loaded.em! } as Config & { em: EmConfig };
  const chain: Chain = {
    provider: {} as JsonRpcProvider,
    merchantAddress: merchant.address,
    balanceOf: async (token, owner) => (token.toLowerCase() === USDG.toLowerCase() ? ledger.get(ledger.usdg, owner) : ledger.get(ledger.wif, owner)),
    tierOf: async (owner): Promise<Tier> => (ledger.get(ledger.wif, owner) >= 100n * W ? "holder" : "standard"),
    sendWif: async (to, amount) => {
      ledger.move(ledger.wif, merchant.address, to, amount);
      if (opts.slowReward && to === workerWallet.address) await new Promise<void>((r) => (heldReward = r));
      return { to, amount, tx: hash() };
    },
  };
  const store = new Store(dir);
  // one clock for the run and the server: a wait of the run is time on the server too (deadlines)
  let clock = Date.now();
  const logs: string[] = [];
  const hire = createEmHire({
    cfg,
    store,
    api: emClient({ apiUrl: cfg.em.apiUrl, wallet: merchant, chainId: 4663, fetch: em.fetch }),
    sendWif: budgetedWif(cfg, chain, store),
    merchant: merchant.address,
    // the SDK's own builder: it has Robinhood Chain's escrow row
    paymentAuth: (pc, worker, deadline) => escrowPaymentAuth({ cfg, wallet: merchant }, pc, worker, deadline),
    releaseOrder: (pi) => releaseOrder({ cfg, wallet: merchant }, pi),
    ready: (pc) => escrowReadiness(cfg, pc),
    usdgBalance: async () => ledger.get(ledger.usdg, merchant.address),
    log: (m) => logs.push(m),
    now: () => new Date(clock),
  });
  const app = createApp({ cfg, chain, store, emHire: hire, log: (m) => logs.push(m), publishWaitMs: 5000, cashbackWaitMs: 5000 });
  const call = async (p: string, init?: RequestInit) => app.fetch(new Request(`http://flatfee.test${p}`, init));
  const workerClient = emWorker({
    apiUrl: "https://em.test",
    fetch: em.fetch,
    auth: opts.workerAuth === "erc8128" ? { kind: "erc8128", wallet: workerWallet, chainId: 4663, client: opts.approvedClient ?? null } : { kind: "token", token: sessionToken, address: workerWallet.address },
  });
  let pays = 0;
  const lines: string[] = [];
  const deps: HireDeps = {
    flatfee: async (p) => (await call(p)).json(),
    // the buyer's x402 payment, signed the way an x402 client signs it
    pay: async (body) => {
      pays++;
      const json = { "content-type": "application/json", "x-payer": buyer.address };
      const first = await call("/api/hire", { method: "POST", headers: json, body: JSON.stringify(body) });
      if (first.status !== 402) return { status: first.status, body: (await first.json()) as Any };
      const accept = ((await first.json()) as Any).accepts[0];
      assert.equal(accept.amount, "250000", "the 402 asks the holder price CONFIRM_MAINNET_SPEND approved");
      const typed = typedDataFor(accept, buyer.address);
      const sig = await buyer.signTypedData(typed.domain, typed.types, typed.message);
      const r = await call("/api/hire", { method: "POST", headers: { ...json, "X-PAYMENT": paymentHeader(accept, typed, sig) }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Any };
    },
    worker: workerClient,
    balances: { usdg: async (a) => ledger.get(ledger.usdg, a), wif: async (a) => ledger.get(ledger.wif, a) },
    payer: buyer.address,
    payTo,
    merchant: merchant.address,
    explorerTx: (h) => `${CHAINS.robinhood.explorer}/tx/${h}`,
    fees: { maxBps: RECORDED.escrow.max_fee_bps, pct: RECORDED.fee_pct },
    // each wait of the run is one pass of the server's loop (EM_POLL_SECONDS on the deploy)
    sleep: async (ms) => {
      clock += ms;
      if (!opts.slowReward) return void (await hire.tick());
      // a held reward is mined now; a pass that blocks on one does not hold up the run
      if (heldReward) {
        heldReward();
        heldReward = null;
      }
      await Promise.race([hire.tick(), new Promise((r) => setTimeout(r, 20))]);
    },
    now: () => clock,
    log: (l) => lines.push(l),
  };
  return { ledger, em, hire, app, call, deps, lines, logs, pays: () => pays, advance: (ms: number) => (clock += ms) };
}

// ------------------------------------------------------------------------------------------------- the run
test("e2e:hire against the doubles: paid, published, applied, escrow locked, delivered, approved, the worker paid and rewarded, every tx and status kept", async () => {
  const w = world();
  await w.hire.tick(); // the server's first check, as start() does at boot
  const info = (await (await w.call("/api/info")).json()) as Any;
  const quote = (await (await w.call(`/api/quote?payer=${buyer.address}`)).json()) as Any;
  const plan = planOf();
  assert.equal(remoteHireRefusal(runCfg(), info, plan, quote.hire), null);

  const o = await runHire(plan, runCfg(), w.deps);
  assert.deepEqual(o.problems, []);
  assert.equal(o.ok, true);
  // every transaction of the hire, each a hash
  for (const [k, v] of Object.entries(o.txs)) assert.match(String(v), /^0x[0-9a-f]{64}$/, k);
  // the money, as the chain moved it: the buyer paid the holder price and got 10 $WIF back; the escrow paid the worker
  // the 0.20 bounty less EM's 13%, and Flat Fee sent the worker 50 $WIF; PAY_TO (the merchant here) got 0.25 and locked 0.20
  assert.deepEqual(o.deltas, { payerUsdg: -250_000n, payToUsdg: 50_000n, merchantUsdg: 50_000n, workerUsdg: 174_000n, workerWif: 50n * W, payerWif: 10n * W });
  // Execution Market's statuses as Flat Fee read them, in order, and Flat Fee's own steps; Flat Fee closes the task in
  // the pass that approves it, so EM's last status is read by the worker, once
  const flat = o.seen.filter((s) => s.source === "flatfee");
  const statuses = [...new Set(flat.map((s) => /em\.status=(\S+)/.exec(s.what)?.[1]).filter((s): s is string => !!s && s !== "-"))];
  assert.deepEqual(statuses, ["published", "accepted", "submitted"]);
  const steps = [...new Set(flat.map((s) => /em\.step=(\S+)/.exec(s.what)?.[1]).filter((s): s is string => !!s))];
  assert.deepEqual(steps, ["published", "assigned", "completed"]);
  const last = o.seen.filter((s) => s.source === "worker").at(-1)!.what;
  assert.match(last, new RegExp(`GET /api/v1/tasks/${o.emTaskId}: status=completed escrow_status=released escrow_tx=${o.txs.escrow} payment_tx=${o.txs.payment}`));
  // the worker applied and delivered as a person (a dashboard session), and the delivery is the buyer's answer
  assert.deepEqual(w.em.st.applies.map((a) => a.type), ["human"]);
  const t = (await (await w.call(`/api/tasks/${o.taskId}`)).json()) as Any;
  assert.equal(t.answer, plan.answer);
  assert.equal(t.worker, workerWallet.address);
  // what the run printed: every tx with its explorer link, and no key, session or RPC URL anywhere
  const printed = w.lines.join("\n");
  for (const tx of Object.values(o.txs)) assert.ok(printed.includes(`${CHAINS.robinhood.explorer}/tx/${tx}`), tx!);
  for (const secret of [buyer.privateKey, merchant.privateKey, workerWallet.privateKey, sessionToken, RUN_ENV.RPC_URL]) {
    assert.ok(!printed.includes(secret) && !printed.includes(secret.replace(/^0x/, "")), "a secret was printed");
    assert.ok(!JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)).includes(secret.replace(/^0x/, "")), "a secret is in the outcome");
  }
});

test("e2e:hire with a worker that signs ERC-8128 as the operator's approved client: assigned and paid the same way", async () => {
  const w = world({ workerAuth: "erc8128", approvedClient: "an-approved-client" });
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.deepEqual(o.problems, []);
  assert.deepEqual(w.em.st.applies.map((a) => a.type), ["human_via_agent"]);
  // the worker signed its application, its delivery and its last read of the task with its own wallet; everything
  // else (publish, assign, review, approve) was signed by the merchant
  const byWorker = w.em.st.calls.filter((c) => c.wallet === workerWallet.address);
  assert.deepEqual(byWorker.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/, ":id")}`), ["POST /api/v1/tasks/:id/apply", "POST /api/v1/tasks/:id/submit", "GET /api/v1/tasks/:id"]);
  assert.ok(w.em.st.calls.every((c) => c.wallet === workerWallet.address || c.wallet === merchant.address));
  assert.ok(w.em.st.calls.some((c) => c.wallet === merchant.address && c.path.endsWith("/assign")));
});

test("a worker Execution Market lists as an agent is never assigned: the run times out saying so, and nothing is delivered", async () => {
  // what the plan's rules refuse up front (no WORKER_EM_CLIENT), forced here to show why
  const w = world({ workerAuth: "erc8128", approvedClient: null });
  await w.hire.tick();
  const o = await runHire({ ...planOf(), timeoutMs: 120_000 }, runCfg(), w.deps);
  assert.equal(o.ok, false);
  assert.match(o.problems.join("\n"), /timed out .*the worker applied but was never assigned/);
  assert.deepEqual(w.em.st.applies.map((a) => a.type), ["agent"]);
  assert.equal([...w.em.st.subs.values()].flat().length, 0);
  assert.equal(o.txs.escrow, null);
});

test("someone else applies first and gets the task: the run stops without delivering, and says who", async () => {
  const w = world();
  await w.hire.tick();
  const stranger = Wallet.createRandom().address;
  const deps: HireDeps = {
    ...w.deps,
    worker: {
      apply: async (taskId) => {
        w.em.stranger(taskId, stranger); // a person with a reputation, ranked first
        return w.deps.worker!.apply(taskId);
      },
      submit: w.deps.worker!.submit,
    },
  };
  const o = await runHire(planOf(), runCfg(), deps);
  assert.equal(o.ok, false);
  assert.ok(o.problems.join("\n").includes(`assigned another applicant (${stranger.slice(0, 6)}…${stranger.slice(-4)})`), o.problems.join("\n"));
  assert.ok(!o.problems.join("\n").includes(stranger));
  assert.equal([...w.em.st.subs.values()].flat().length, 0);
});

test("the run fails when a leg is missing: no $WIF reward to the worker", async () => {
  const w = world();
  await w.hire.tick();
  // the merchant's $WIF is gone by the time the reward goes out
  const deps: HireDeps = {
    ...w.deps,
    worker: {
      apply: w.deps.worker!.apply,
      submit: async (id, text) => {
        w.ledger.wif.set(merchant.address.toLowerCase(), 0n);
        return w.deps.worker!.submit(id, text);
      },
    },
  };
  const o = await runHire(planOf(), runCfg(), deps);
  assert.equal(o.ok, false);
  assert.match(o.problems.join("\n"), /no \$WIF reward transaction/);
  assert.match(o.problems.join("\n"), /the worker's \$WIF moved \+0, not \+50/);
});

test("the verdict reads the chain: a buyer charged more, a worker paid outside the bounty less EM's fee, or a short cashback fails the run", async () => {
  // what the chain would say if it did not match the server's story: each reading is off from the real one by `off`
  const cases: { what: string; off: (who: string, kind: "usdg" | "wif") => bigint; why: RegExp }[] = [
    { what: "the buyer paid 0.01 more", off: (who, k) => (k === "usdg" && who === buyer.address ? -10_000n : 0n), why: /the buyer's USDG moved -0.26, not -0.25/ },
    { what: "the worker got less than the bounty less EM's largest fee", off: (who, k) => (k === "usdg" && who === workerWallet.address ? -20_000n : 0n), why: /the worker's USDG moved \+0.154, outside 0.164..0.20/ },
    { what: "the worker got more than the bounty", off: (who, k) => (k === "usdg" && who === workerWallet.address ? 30_000n : 0n), why: /the worker's USDG moved \+0.204, outside/ },
    { what: "the escrow took 0.01 more than the bounty from the merchant", off: (who, k) => (k === "usdg" && who === merchant.address ? -10_000n : 0n), why: /the merchant's USDG moved 0.04, not 0.05 \(the price in, the bounty out to the escrow/ },
    { what: "the buyer's cashback came short", off: (who, k) => (k === "wif" && who === buyer.address ? -1n : 0n), why: /the buyer's \$WIF moved \+9.999999999999999999, not the \+10 cashback/ },
  ];
  for (const c of cases) {
    const w = world();
    await w.hire.tick();
    let after = false; // the readings are off only once the hire was paid
    const real = w.deps.balances;
    const deps: HireDeps = {
      ...w.deps,
      pay: async (b) => {
        const r = await w.deps.pay(b);
        after = true;
        return r;
      },
      balances: {
        usdg: async (a) => (await real.usdg(a)) + (after ? c.off(a, "usdg") : 0n),
        wif: async (a) => (await real.wif(a)) + (after ? c.off(a, "wif") : 0n),
      },
    };
    const o = await runHire(planOf(), runCfg(), deps);
    assert.equal(o.ok, false, c.what);
    assert.match(o.problems.join("\n"), c.why, c.what);
  }
});

test("manual mode: the run prints the EM task and the exact text, and waits for a person to apply and deliver", async () => {
  const w = world();
  await w.hire.tick();
  const plan = planOf({ ...RUN_ENV, WORKER_MODE: "manual", WORKER_EM_TOKEN: undefined });
  const person = emWorker({ apiUrl: "https://em.test", fetch: w.em.fetch, auth: { kind: "token", token: sessionToken, address: workerWallet.address } });
  let step = 0;
  const deps: HireDeps = {
    ...w.deps,
    worker: null,
    // the person on execution.market, a few passes after the run asked
    sleep: async (ms) => {
      await w.deps.sleep(ms);
      step++;
      const t = (await (await w.call("/api/tasks")).json()) as Any[];
      const em = t[0]?.em;
      if (step === 2) await person.apply(em.taskId);
      if (em?.status === "accepted" && ![...w.em.st.subs.values()].flat().length) await person.submit(em.taskId, plan.answer);
    },
  };
  const o = await runHire(plan, runCfg(), deps);
  assert.deepEqual(o.problems, []);
  assert.ok(w.lines.some((l) => l.includes(`apply to task ${o.emTaskId}`) && l.includes(plan.answer)));
});

test("a server that would refuse the hire is never paid: /api/info says paused, and the run refuses before the payment", async () => {
  const w = world();
  // the merchant holds less than one bounty
  w.ledger.usdg.set(merchant.address.toLowerCase(), 100_000n);
  await w.hire.tick();
  const info = (await (await w.call("/api/info")).json()) as Any;
  const why = remoteHireRefusal(runCfg(), info, planOf(), "0.25");
  assert.match(why ?? "", /not taking hires right now \(The wallet that pays the escrow cannot fund one more task right now\.\): refusing before anyone pays/);
  // and the run itself reads /api/info again right before paying
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.equal(o.ok, false);
  assert.match(o.problems.join("\n"), /not taking hires through Execution Market right now \(The wallet that pays the escrow cannot fund one more task right now\.\): nothing paid/);
  assert.equal(w.pays(), 0);
  assert.equal(w.ledger.get(w.ledger.usdg, buyer.address), 588_716n);
});

test("the worker's $WIF is mined after Flat Fee marked the task done: the run waits for its hash instead of failing", async () => {
  const w = world({ slowReward: true });
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.deepEqual(o.problems, []);
  assert.match(String(o.txs.reward), /^0x[0-9a-f]{64}$/);
  // the run did see the task done with no reward yet, then the reward
  const flat = o.seen.filter((x) => x.source === "flatfee").map((x) => x.what);
  const doneNoReward = flat.findIndex((l) => /status=done/.test(l) && !/rewardTx=/.test(l));
  const doneReward = flat.findIndex((l) => /status=done/.test(l) && /rewardTx=0x/.test(l));
  assert.ok(doneNoReward >= 0 && doneReward > doneNoReward, flat.join("\n"));
});

test("an approval that came back without its payment tx: the release tx is the one EM shows the worker on the task", async () => {
  const w = world({ workerAuth: "erc8128", approvedClient: "an-approved-client" });
  w.em.st.approveWithoutTx = true;
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.deepEqual(o.problems, []);
  const t = (await (await w.call(`/api/tasks/${o.taskId}`)).json()) as Any;
  assert.equal(t.em.paymentTx, null);
  assert.equal(o.txs.payment, w.em.st.tasks.get(o.emTaskId!)!.payment_tx);
});

test("PAY_TO apart from the merchant: PAY_TO gets the price, the merchant locks the bounty, each checked on chain", async () => {
  const shop = Wallet.createRandom().address;
  const w = world({ payTo: shop });
  await w.hire.tick();
  const o = await runHire(planOf({ ...RUN_ENV, PAY_TO: shop }), loadConfig({ ...RUN_ENV, PAY_TO: shop }), w.deps);
  assert.deepEqual(o.problems, []);
  assert.equal(o.deltas!.payToUsdg, 250_000n);
  assert.equal(o.deltas!.merchantUsdg, -200_000n);
  // and a PAY_TO that got less than the price fails the run
  const short = world({ payTo: shop });
  await short.hire.tick();
  let paid = false;
  const real = short.deps.balances;
  const deps: HireDeps = {
    ...short.deps,
    pay: async (b) => {
      const r = await short.deps.pay(b);
      paid = true;
      return r;
    },
    balances: { ...real, usdg: async (a) => (await real.usdg(a)) - (paid && a === shop ? 10_000n : 0n) },
  };
  const bad = await runHire(planOf({ ...RUN_ENV, PAY_TO: shop }), loadConfig({ ...RUN_ENV, PAY_TO: shop }), deps);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join("\n"), /PAY_TO's USDG moved 0.24, not \+0.25/);
});

test("the buyer's answer must be the worker's text: an answer that is not fails the run", async () => {
  const w = world();
  await w.hire.tick();
  const deps: HireDeps = { ...w.deps, worker: { ...w.deps.worker!, submit: (id) => w.deps.worker!.submit(id, "some other text") } };
  const o = await runHire(planOf(), runCfg(), deps);
  assert.equal(o.ok, false);
  assert.deepEqual(o.problems, ["the buyer's answer on Flat Fee is not the text the worker delivered"]);
});

test("a buyer without the price in USDG is not charged at all: the run stops before paying", async () => {
  const w = world();
  w.ledger.usdg.set(buyer.address.toLowerCase(), 249_999n);
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.equal(o.ok, false);
  assert.match(o.problems[0], /the buyer holds 0.249999 USDG, below the 0.25 it would pay/);
  assert.equal(w.pays(), 0);
});

// ------------------------------------------------------------------------------------------------- nobody finishes it
test("what a buyer is told about a hire nobody finishes, word for word, in /api/info and in the 201", async () => {
  const told =
    "The task is on Execution Market, for any of its people to take. If no one takes it within 24 h, it expires there, with nothing locked for it. " +
    "If the person who takes it does not deliver by then, Execution Market returns the escrowed pay to Flat Fee's wallet. " +
    "Either way, the fee you paid is not refunded.";
  assert.equal(hireExpiry(24), told);
  const w = world();
  await w.hire.tick();
  assert.equal(((await (await w.call("/api/info")).json()) as Any).hire.expiry, told);
  const r = await w.deps.pay({ request: "Is the cafe on 5th street open?" });
  assert.equal(r.status, 201);
  assert.equal(r.body.expiry, told);
});

test("nobody takes the task by its deadline: cancelled on EM, nothing locked, so the merchant's USDG never moved; the buyer sees it expired, unrefunded", async () => {
  const w = world();
  await w.hire.tick();
  const merchantBefore = w.ledger.get(w.ledger.usdg, merchant.address);
  const r = await w.deps.pay({ request: "Is the cafe on 5th street open?" });
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  // a day of passes with no applicant, then the deadline
  for (let h = 0; h < 24; h++) {
    w.advance(3_600_000);
    await w.hire.tick();
  }
  w.advance(60_000);
  await w.hire.tick();
  const t = (await (await w.call(`/api/tasks/${id}`)).json()) as Any;
  assert.equal(t.status, "expired");
  assert.equal(t.em.step, "expired");
  assert.match(t.em.lastError, /nobody took the task before its deadline; cancelled on Execution Market, nothing was locked/);
  assert.equal(t.worker, null);
  assert.equal(t.rewardTx, null);
  assert.deepEqual(w.em.st.cancels, [emId]);
  assert.equal(w.em.st.tasks.get(emId)!.status, "cancelled");
  // the money: the buyer's 0.25 stayed with PAY_TO (the merchant here), and no escrow was ever locked
  assert.equal(w.ledger.get(w.ledger.usdg, merchant.address) - merchantBefore, 250_000n);
  assert.equal(w.ledger.get(w.ledger.usdg, RH.escrow), 0n);
  assert.equal(w.ledger.get(w.ledger.usdg, buyer.address), 588_716n - 250_000n);
});

test("taken but not delivered by the deadline: EM expires it and its escrow returns the 0.20 to the merchant; no $WIF, and the buyer sees it expired", async () => {
  const w = world();
  await w.hire.tick();
  const merchantBefore = w.ledger.get(w.ledger.usdg, merchant.address);
  const merchantWif = w.ledger.get(w.ledger.wif, merchant.address);
  const r = await w.deps.pay({ request: "Is the cafe on 5th street open?" });
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  await w.deps.worker!.apply(emId);
  await w.hire.tick(); // assigned: the merchant's 0.20 is locked
  assert.equal(w.ledger.get(w.ledger.usdg, RH.escrow), 200_000n);
  assert.equal(w.ledger.get(w.ledger.usdg, merchant.address) - merchantBefore, 50_000n);
  // nobody delivers; EM's deadline passes
  w.em.expire(emId);
  w.advance(25 * 3_600_000);
  await w.hire.tick();
  const t = (await (await w.call(`/api/tasks/${id}`)).json()) as Any;
  assert.equal(t.status, "expired");
  assert.match(t.em.lastError, /the task was expired on Execution Market/);
  assert.equal(t.answer, null);
  assert.equal(t.rewardTx, null);
  // the escrow went back: the merchant holds the buyer's 0.25 and its own 0.20 again; the worker got nothing
  assert.equal(w.ledger.get(w.ledger.usdg, RH.escrow), 0n);
  assert.equal(w.ledger.get(w.ledger.usdg, merchant.address) - merchantBefore, 250_000n);
  assert.equal(w.ledger.get(w.ledger.usdg, workerWallet.address), 0n);
  assert.equal(w.ledger.get(w.ledger.wif, workerWallet.address), 0n);
  // the only $WIF that left the merchant is the buyer's cashback, sent at payment
  assert.equal(merchantWif - w.ledger.get(w.ledger.wif, merchant.address), 10n * W);
});

test("the deploy's reputation network goes with every publish; if EM refuses it, the run says what to do", async () => {
  const ok = world();
  await ok.hire.tick();
  assert.equal((await runHire(planOf(), runCfg(), ok.deps)).ok, true);
  assert.equal(ok.em.st.creates[0].reputation_network, "robinhood");
  const w = world();
  w.em.st.refuseReputation = true;
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), w.deps);
  assert.equal(o.ok, false);
  assert.match(o.problems[0], /the task ended failed on Flat Fee: Execution Market refused the task: .*INVALID_REPUTATION_NETWORK/i);
  assert.match(o.problems[1], /refused reputation_network .*turn EM_HIRE off on the deploy/);
  // and the server stops taking hires: the next buyer is not charged for a task EM would refuse too
  assert.equal(((await (await w.call("/api/info")).json()) as Any).hire.paused.kind, "refused");
  assert.equal(publishHint("Execution Market answered 403 identity_required: no identity"), "the merchant wallet has no ERC-8004 identity on Base: run npm run em:register (once), then redeploy; hiring is paused there until then");
  assert.equal(publishHint("nobody took the task before its deadline"), null);
});

// ------------------------------------------------------------------------------------------------- re-runs and lost answers
test("another hire still open on the server: the run refuses before paying, since its escrow and reward move the same wallets", async () => {
  const w = world();
  await w.hire.tick();
  // a first run that left its hire open: someone else was assigned and the run stopped
  const stranger = Wallet.createRandom().address;
  const first = await runHire(planOf(), runCfg(), {
    ...w.deps,
    worker: { ...w.deps.worker!, apply: async (id) => (w.em.stranger(id, stranger), w.deps.worker!.apply(id)) },
  });
  assert.equal(first.ok, false);
  const paidOnce = w.pays();
  const again = await runHire(planOf(), runCfg(), w.deps);
  assert.equal(again.ok, false);
  assert.match(again.problems[0], /1 other hire is still open on the server \([0-9a-f]{8}\): .*nothing paid/);
  assert.equal(w.pays(), paidOnce);
});

test("an apply or a delivery that got no answer (a timeout, a 5xx) is tried again while the task is followed, not a failure", async () => {
  for (const which of ["apply", "submit"] as const) {
    const w = world();
    await w.hire.tick();
    let failed = 0;
    const real = w.deps.worker!;
    const lost = async () => {
      failed++;
      throw new EmWorkerError(0, "unreachable", "Execution Market did not answer within 20000 ms");
    };
    const deps: HireDeps = {
      ...w.deps,
      worker: which === "apply" ? { ...real, apply: async (id) => (failed < 2 ? lost() : real.apply(id)) } : { ...real, submit: async (id, t) => (failed < 2 ? lost() : real.submit(id, t)) },
    };
    const o = await runHire(planOf(), runCfg(), deps);
    assert.deepEqual(o.problems, [], which);
    assert.equal(failed, 2, which);
    assert.equal(o.seen.filter((x) => x.source === "worker" && /got no answer/.test(x.what)).length, 2, which);
  }
  // the first apply landed but its answer was lost: the next one is EM's 409, and the run goes on
  {
    const w = world();
    await w.hire.tick();
    let calls = 0;
    const real = w.deps.worker!;
    const deps: HireDeps = {
      ...w.deps,
      worker: {
        ...real,
        apply: async (id) => {
          if (++calls === 1) {
            await real.apply(id);
            throw new EmWorkerError(0, "unreachable", "Execution Market did not answer within 20000 ms");
          }
          throw new EmWorkerError(409, "already_applied", "Execution Market answered 409 already_applied");
        },
      },
    };
    const o = await runHire(planOf(), runCfg(), deps);
    assert.deepEqual(o.problems, []);
    assert.equal(calls, 2);
    assert.ok(o.seen.some((x) => x.source === "worker" && /apply: already applied/.test(x.what)));
  }
  // a refusal with a verdict still stops the run
  const w = world();
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), { ...w.deps, worker: { ...w.deps.worker!, apply: async () => { throw new EmWorkerError(403, "forbidden", "Execution Market answered 403"); } } });
  assert.deepEqual(o.problems, ["Execution Market did not take the worker's application"]);
});

test("a payment call that throws still gives an outcome, and says the hire may have been paid", async () => {
  const w = world();
  await w.hire.tick();
  const o = await runHire(planOf(), runCfg(), { ...w.deps, pay: async () => { throw new Error("socket hang up"); } });
  assert.equal(o.ok, false);
  assert.match(o.problems[0], /the payment call failed \(socket hang up\): it may have settled; read the buyer's wallet on the explorer before any re-run/);
});

test("the worker must get paid something, whatever fee bound EM serves", async () => {
  for (const maxBps of [10_000, 25_000, -5]) {
    const w = world();
    await w.hire.tick();
    const real = w.deps.balances;
    let paid = false;
    const deps: HireDeps = {
      ...w.deps,
      fees: { maxBps, pct: null },
      pay: async (b) => {
        const r = await w.deps.pay(b);
        paid = true;
        return r;
      },
      // the escrow paid the worker nothing
      balances: { ...real, usdg: async (a) => (await real.usdg(a)) - (paid && a === workerWallet.address ? 174_000n : 0n) },
    };
    const o = await runHire(planOf(), runCfg(), deps);
    assert.equal(o.ok, false, String(maxBps));
    assert.match(o.problems.join("\n"), /the worker's USDG moved \+0, outside/, String(maxBps));
  }
});

// ------------------------------------------------------------------------------------------------- the rules
test("the rules: mainnet only, the private RPC only, every amount approved, a worker that is nobody else", () => {
  const refusal = (env: Record<string, string | undefined>, payer = buyer.address) => {
    const r = hirePlanRefusal(loadConfig({ ...RUN_ENV, ...env } as Record<string, string>), { ...RUN_ENV, ...env }, payer);
    return "refusal" in r ? r.refusal : null;
  };
  assert.equal(refusal({}), null);
  assert.match(refusal({ NETWORK: "robinhood-testnet", WIF_CASHBACK: "0" })!, /mainnet only/);
  assert.match(refusal({ RPC_URL: undefined })!, /RPC_URL is not set/);
  assert.match(refusal({ RPC_URL: "" })!, /RPC_URL is not set/);
  for (const pub of ["https://rpc.mainnet.chain.robinhood.com", "https://RPC.MAINNET.CHAIN.ROBINHOOD.COM/", "https://rpc.testnet.chain.robinhood.com", "https://other.chain.robinhood.com/x"]) {
    assert.match(refusal({ RPC_URL: pub })!, /public RPC/, pub);
  }
  assert.match(refusal({ RPC_URL: "not a url with key abc123" })!, /not a URL; the value is not shown/);
  assert.ok(!refusal({ RPC_URL: "not a url with key abc123" })!.includes("abc123"));
  for (const key of ["CONFIRM_MAINNET_SPEND", "CONFIRM_MAINNET_BOUNTY", "CONFIRM_MAINNET_REWARD"]) {
    assert.match(refusal({ [key]: undefined })!, new RegExp(key), key);
    assert.match(refusal({ [key]: "  " })!, new RegExp(key), key);
  }
  for (const bad of [undefined, "http://flatfee.example", "ftp://x", "https://flatfee.example/api", "https://user:pw@flatfee.example", "nope"]) {
    assert.match(refusal({ FLATFEE_URL: bad })!, /FLATFEE_URL/, String(bad));
  }
  assert.equal(origin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(origin("https://flatfee.example/"), "https://flatfee.example");
  assert.match(refusal({ EM_API_URL: "http://api.execution.market" })!, /EM_API_URL/);
  // the worker
  assert.match(refusal({ WORKER_MODE: undefined })!, /WORKER_MODE must be/);
  assert.match(refusal({ WORKER_MODE: "robot" })!, /WORKER_MODE must be/);
  assert.equal(refusal({ WORKER_MODE: " Token " }), null);
  assert.match(refusal({ WORKER_EM_TOKEN: undefined })!, /needs WORKER_EM_TOKEN/);
  assert.match(refusal({ WORKER_MODE: "manual", WORKER_WALLET: undefined })!, /needs WORKER_WALLET/);
  assert.match(refusal({ WORKER_MODE: "manual", WORKER_WALLET: "0x1234" })!, /needs WORKER_WALLET/);
  assert.equal(refusal({ WORKER_MODE: "manual", WORKER_WALLET: workerWallet.address.toLowerCase() }), null);
  assert.match(refusal({ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: undefined })!, /needs WORKER_PRIVATE_KEY/);
  assert.match(refusal({ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: "0x1234" })!, /WORKER_PRIVATE_KEY is not a private key \(0x and 64 hex digits\); the value is not shown/);
  // a script's ERC-8128 worker is an agent to Execution Market, and Flat Fee assigns only people
  assert.match(refusal({ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: workerWallet.privateKey })!, /WORKER_MODE=erc8128 needs WORKER_EM_CLIENT, the client value the operator approved/);
  // an empty EM_API_URL (a .env copied from .env.example) is Execution Market's own
  for (const empty of ["", "  "]) {
    const p = hirePlanRefusal(loadConfig(RUN_ENV), { ...RUN_ENV, EM_API_URL: empty }, buyer.address);
    assert.ok("plan" in p && p.plan.emApi === "https://api.execution.market", JSON.stringify(empty));
  }
  assert.equal(refusal({ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: workerWallet.privateKey, WORKER_EM_CLIENT: "x" }), null);
  // nobody else's wallet: not the buyer, not PAY_TO, not the merchant, in any case
  assert.match(refusal({ WORKER_WALLET: buyer.address.toUpperCase().replace("0X", "0x") })!, /cannot be the buyer/);
  assert.match(refusal({ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: buyer.privateKey, WORKER_EM_CLIENT: "x" })!, /cannot be the buyer/);
  assert.match(refusal({ WORKER_WALLET: merchant.address.toLowerCase() })!, /cannot be PAY_TO/);
  const other = Wallet.createRandom();
  assert.match(refusal({ PAY_TO: other.address, WORKER_WALLET: merchant.address })!, /cannot be the merchant/);
  // the waits
  assert.match(refusal({ E2E_TIMEOUT_MINUTES: "0" })!, /E2E_TIMEOUT_MINUTES/);
  assert.match(refusal({ E2E_TIMEOUT_MINUTES: "abc" })!, /E2E_TIMEOUT_MINUTES/);
  assert.match(refusal({ E2E_POLL_SECONDS: "0.5" })!, /E2E_POLL_SECONDS/);
  assert.match(refusal({ E2E_ANSWER: "x".repeat(2001) })!, /E2E_ANSWER/);
  assert.match(refusal({ E2E_REQUEST: "x".repeat(501) })!, /E2E_REQUEST/);
  // no message ever repeats a key
  for (const env of [{ WORKER_MODE: "erc8128", WORKER_PRIVATE_KEY: workerWallet.privateKey.slice(0, 60) }, {}]) {
    const m = refusal(env) ?? "";
    assert.ok(!m.includes(workerWallet.privateKey.slice(2, 40)));
  }
  assert.equal(rpcRefusal({ RPC_URL: RUN_ENV.RPC_URL }), null);
});

test("the server must be the one approved: Execution Market on, taking hires, the approved bounty, reward, cashback and price", async () => {
  const w = world();
  await w.hire.tick();
  const info = (await (await w.call("/api/info")).json()) as Any;
  const plan = planOf();
  const cfg = runCfg();
  assert.equal(remoteHireRefusal(cfg, info, plan, "0.25"), null);
  // e2e:mainnet's own checks come first
  assert.match(remoteHireRefusal(cfg, { ...info, localFork: true }, plan, "0.25")!, /localFork/);
  assert.match(remoteHireRefusal(cfg, { ...info, payTo: Wallet.createRandom().address }, plan, "0.25")!, /pay-to/);
  const cases: [Any, RegExp, string?][] = [
    [{ ...info, hire: { via: "board" } }, /hires through board, not Execution Market/],
    [{ ...info, hire: { ...info.hire, available: false, paused: { kind: "unchecked", reason: "Flat Fee has not finished checking that a hire can run yet." } } }, /not taking hires right now \(Flat Fee has not finished checking that a hire can run yet\.\)/],
    [{ ...info, hire: { ...info.hire, available: undefined } }, /not taking hires right now \(it does not say why\)/],
    [{ ...info, hire: { ...info.hire, available: "true" } }, /not taking hires right now/],
    [{ ...info, hire: { ...info.hire, bounty: "0.3" } }, /locks 0.3 USDG per hire, CONFIRM_MAINNET_BOUNTY is 0.20/],
    [{ ...info, wif: { ...info.wif, workerReward: "0" } }, /sends no \$WIF to the worker/],
    [{ ...info, wif: { ...info.wif, workerReward: "60" } }, /sends the worker 60 \$WIF, CONFIRM_MAINNET_REWARD is 50/],
    [{ ...info, prices: { ...info.prices, hire: { standard: "0.6", holder: "0.25" } } }, /hire price 0.6/],
    [{ ...info, prices: { ...info.prices, hire: { standard: "0.5", holder: "0.3" } } }, /holder hire price 0.3/],
    [info, /would pay 0.5 USDG for this hire; CONFIRM_MAINNET_SPEND is 0.25/, "0.5"],
  ];
  for (const [bad, why, price] of cases) assert.match(remoteHireRefusal(cfg, bad, plan, price ?? "0.25") ?? "", why, String(why));
  assert.match(remoteHireRefusal(cfg, info, plan, null)!, /would pay null/);
  // the cashback: approved, and exactly
  assert.match(remoteHireRefusal(cfg, info, { ...plan, approved: { ...plan.approved, cashback: null } }, "0.25")!, /CONFIRM_MAINNET_WIF=10/);
  assert.match(remoteHireRefusal(cfg, info, { ...plan, approved: { ...plan.approved, cashback: "9" } }, "0.25")!, /CONFIRM_MAINNET_WIF=10/);
  // an approval written another way is the same amount
  assert.equal(remoteHireRefusal(cfg, info, { ...plan, approved: { ...plan.approved, spend: "0.250", bounty: "0.2", reward: "50.0" } }, "0.25"), null);
});
