// Hiring a human through Execution Market (EM_HIRE=on), against a double of EM's API: no network, no credentials.
// The double checks every request's ERC-8128 signature with the SDK's verifier in EM's own posture (em-lenient), and
// checks the escrow authorization of an assignment the way the facilitator would before locking it.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet, getAddress, hexlify, verifyTypedData, type BaseWallet, type JsonRpcProvider } from "ethers";
import { ESCROW_OPERATORS, ESCROW_PAYMENT_INFO_TYPEHASH, VERIFIED_USDC_DOMAINS, buildEscrowPreAuth, computeEscrowNonce } from "uvd-x402-sdk";
import { ESCROW_CONTRACTS } from "uvd-x402-sdk/backend";
import { policyFromPreset, verifyRequest, type NonceStore } from "uvd-x402-sdk/erc8128";
import { createApp } from "../src/app.js";
import type { Chain, Tier } from "../src/chain.js";
import { CHAINS, ConfigError, loadConfig, type Config, type EmConfig } from "../src/config.js";
import { EmHttpError, emClient, type Fetch } from "../src/em.js";
import { MAX_ANSWER_BYTES, answerOf, createEmHire, manifestProblem } from "../src/emhire.js";
import { EscrowRefused, checkPaymentAuth, escrowNetwork, escrowPaymentAuth, escrowReadiness, sdkHasEscrowRow, typedDataSigner, type BuildPreAuth } from "../src/escrow.js";
import { Store } from "../src/store.js";
import { budgetedWif } from "../src/wif.js";
// @ts-expect-error plain JS module shared with the browser
import { paymentHeader, typedDataFor } from "../public/x402-browser.js";

const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F"; // Robinhood Chain Testnet
const MAINNET_USDG = CHAINS.robinhood.usdg;
const CHAIN_ID = 46630;
const WIF = 10n ** 18n;
const merchant = Wallet.createRandom();
const buyer = Wallet.createRandom();
const holder = Wallet.createRandom();
const payTo = Wallet.createRandom().address;
const CONTRACTS = { escrow: Wallet.createRandom().address, operator: Wallet.createRandom().address, tokenCollector: Wallet.createRandom().address };
const EM_ENV = {
  EM_HIRE: "on",
  EM_API_URL: "https://em.test",
  EM_ESCROW_ADDRESS: CONTRACTS.escrow,
  EM_OPERATOR_ADDRESS: CONTRACTS.operator,
  EM_TOKEN_COLLECTOR_ADDRESS: CONTRACTS.tokenCollector,
};
const RECEIVE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

// the tasks' clock (deadlines); ERC-8128 signatures keep the real one
let clockMs = Date.now();
const clock = () => clockMs;

// ---------------------------------------------------------------------------------------------------------------
// the facilitator of the buyer's x402 payment: verifies anything well formed, settles each nonce once
const spent = new Set<string>();
const fac = new Hono();
fac.post("/verify", async (c) => {
  const b = await c.req.json();
  return c.json({ isValid: true, payer: b.paymentPayload.payload.authorization.from });
});
fac.post("/settle", async (c) => {
  const b = await c.req.json();
  const { nonce, from } = b.paymentPayload.payload.authorization;
  if (spent.has(nonce)) return c.json({ success: false, errorReason: "authorization_already_used", network: "eip155:46630" });
  spent.add(nonce);
  return c.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:46630", payer: from });
});

// the chain: `holder` holds $WIF; $WIF sends are recorded
const sent: { to: string; amount: bigint }[] = [];
let sendFails = false;
const chain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: merchant.address,
  balanceOf: async () => 0n,
  tierOf: async (owner: string): Promise<Tier> => (owner.toLowerCase() === holder.address.toLowerCase() ? "holder" : "standard"),
  sendWif: async (to: string, amount: bigint) => {
    if (sendFails) throw new Error("merchant out of $WIF");
    sent.push({ to, amount });
    return { to, amount, tx: "0x" + "cd".repeat(32) };
  },
};

// ---------------------------------------------------------------------------------------------------------------
// the double of Execution Market's API
type Any = Record<string, any>;

function emDouble() {
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
    ops: new Map<string, Any>(),
    byKey: new Map<string, string>(),
    /** every signed request: method, path and the wallet that signed it */
    calls: [] as { method: string; path: string; wallet: string }[],
    creates: [] as { body: Any; key: string | undefined }[],
    assigns: [] as { taskId: string; executorId: string; auth: Any }[],
    opened: new Set<string>(),
    rejects: [] as { submissionId: string; notes: string; severity: string; opened: boolean }[],
    approvals: [] as string[],
    cancels: [] as string[],
    fetches: 0,
  };
  const knobs = {
    hang: false,
    asyncAssign: false,
    asyncApprove: false,
    lockFails: false,
    refuseCreate: false,
    /** EM's listing lags behind a rejection: the delivery still reads pending */
    staleReject: false,
    /** escrow parameters EM publishes, changed per test */
    network: { chain_id: CHAIN_ID, usdc: USDG, ...{ escrow: CONTRACTS.escrow, operator: CONTRACTS.operator, token_collector: CONTRACTS.tokenCollector } } as Any,
  };
  const app = new Hono<{ Variables: { wallet: string } }>();
  app.get("/api/v1/auth/erc8128/nonce", (c) => {
    const n = randomBytes(16).toString("hex");
    issued.add(n);
    return c.json({ nonce: n, ttl_seconds: 300, message: "put it in Signature-Input" });
  });
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/auth/erc8128/nonce") return next();
    if (knobs.hang) await new Promise(() => undefined);
    const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const v = await verifyRequest(
      { method: c.req.method, url: c.req.url, headers: Object.fromEntries(c.req.raw.headers), rawBody: bytes.length ? bytes : undefined },
      policy,
    );
    if (!v.ok) return c.json({ error: v.code, message: v.message }, v.status as 401);
    st.calls.push({ method: c.req.method, path: c.req.path, wallet: getAddress(v.wallet) });
    c.set("wallet", getAddress(v.wallet));
    return next();
  });
  const own = (c: any, id: string) => {
    const t = st.tasks.get(id);
    return t && t.agent_id === c.get("wallet") ? t : null;
  };
  app.post("/api/v1/tasks", async (c) => {
    const key = c.req.header("idempotency-key");
    const body = await c.req.json();
    st.creates.push({ body, key });
    if (key && st.byKey.has(key)) return c.json(st.tasks.get(st.byKey.get(key)!), 200);
    if (knobs.refuseCreate) return c.json({ detail: { error: "invalid_payment_token", message: "USDG is not enabled on robinhood-testnet" } }, 422);
    const id = randomUUID();
    const task = {
      id,
      status: "published",
      title: body.title,
      bounty_usd: body.bounty_usd,
      payment_network: body.payment_network,
      deadline: new Date(clock() + body.deadline_hours * 3_600_000).toISOString(),
      agent_id: c.get("wallet"),
      escrow_tx: null as string | null,
      payment_tx: null as string | null,
      escrow_lock_failure: null as Any | null,
      executor_id: null as string | null,
    };
    st.tasks.set(id, task);
    if (key) st.byKey.set(key, id);
    st.apps.set(id, []);
    st.subs.set(id, []);
    return c.json(task, 201);
  });
  app.get("/api/v1/tasks/:id", (c) => {
    const t = own(c, c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "TASK_NOT_FOUND", message: "no" }, 404);
  });
  app.get("/api/v1/tasks/:id/applications", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN", message: "only the publisher" }, 403);
    const a = st.apps.get(t.id)!;
    return c.json({ applications: a, count: a.length });
  });
  app.get("/api/v1/h2a/payment-config", (c) =>
    c.json({
      treasury: Wallet.createRandom().address,
      fee_pct: 0.13,
      escrow: {
        payment_info_typehash: ESCROW_PAYMENT_INFO_TYPEHASH,
        min_fee_bps: 0,
        max_fee_bps: 1800,
        tier_timings: { micro: { pre: 3600, auth: 7200, refund: 86400 } },
        networks: { "robinhood-testnet": knobs.network },
      },
    }),
  );
  app.post("/api/v1/tasks/:id/assign", async (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN", message: "only the publisher" }, 403);
    if (t.status !== "published") return c.json({ error: "TASK_NOT_ASSIGNABLE", message: t.status }, 409);
    const { executor_id } = await c.req.json();
    const app_ = st.apps.get(t.id)!.find((a) => a.executor_id === executor_id);
    const auth = JSON.parse(c.req.header("x-payment-auth") ?? "null");
    st.assigns.push({ taskId: t.id, executorId: executor_id, auth });
    // what the facilitator checks before it locks: a signed ReceiveWithAuthorization of the bounty, from the
    // authenticated publisher, to the token collector, whose nonce commits to the applicant as receiver
    const a = auth?.payload?.authorization;
    const pi = auth?.payload?.paymentInfo;
    const domain = { name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: USDG };
    const bounty = String(Math.round(t.bounty_usd * 1e6));
    const ok =
      auth?.scheme === "escrow" &&
      app_ &&
      getAddress(verifyTypedData(domain, { ReceiveWithAuthorization: RECEIVE }, a, auth.payload.signature)) === c.get("wallet") &&
      getAddress(a.from) === c.get("wallet") &&
      getAddress(a.to) === getAddress(CONTRACTS.tokenCollector) &&
      a.value === bounty &&
      getAddress(pi.receiver) === getAddress(app_.wallet_address) &&
      a.nonce === computeEscrowNonce(CHAIN_ID, CONTRACTS.escrow, ESCROW_PAYMENT_INFO_TYPEHASH, pi);
    if (!ok) return c.json({ detail: { error: "escrow_lock_failed", code: "INVALID_SIGNATURE", message: "the authorization does not lock this task" } }, 402);
    t.executor_id = executor_id;
    if (knobs.asyncAssign || knobs.lockFails) {
      t.status = "assigning";
      return c.json({ success: true, status: "assigning", task_id: t.id, executor_id, escrow_status: "locking" }, 202);
    }
    t.status = "accepted";
    t.escrow_tx = "0x" + "e5".repeat(32);
    return c.json({ success: true, message: "Task assigned successfully", data: { task_id: t.id, executor_id, status: "accepted", worker_wallet: app_.wallet_address } });
  });
  app.get("/api/v1/tasks/:id/submissions", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN", message: "only the publisher" }, 403);
    // the status listing never hands over the evidence, only its manifest
    const subs = st.subs.get(t.id)!.map((s) => ({ ...s, evidence: null, evidence_manifest: manifest(s.evidence) }));
    return c.json({ submissions: subs, count: subs.length });
  });
  const sub = (id: string) => [...st.subs.values()].flat().find((s) => s.id === id);
  app.post("/api/v1/submissions/:sid/evidence/open", (c) => {
    const s = sub(c.req.param("sid"));
    if (!s || !own(c, s.task_id)) return c.json({ error: "FORBIDDEN", message: "not the publisher" }, 403);
    st.opened.add(s.id);
    return c.json({ submission_id: s.id, task_id: s.task_id, evidence: s.evidence, notes: s.notes, files: [], files_total: 0, first_open: true });
  });
  app.post("/api/v1/submissions/:sid/approve", async (c) => {
    const s = sub(c.req.param("sid"));
    if (!s || !own(c, s.task_id)) return c.json({ error: "FORBIDDEN", message: "not the publisher" }, 403);
    if (s.agent_verdict) return c.json({ error: "CONFLICT", message: `already ${s.agent_verdict}` }, 409);
    st.approvals.push(s.id);
    const t = st.tasks.get(s.task_id)!;
    if (knobs.asyncApprove) {
      const id = randomUUID();
      st.ops.set(id, { submission: s, task: t, done: false, state: "queued" });
      return c.json({ success: true, status: "approving", operation_id: id, poll: `/api/v1/settlement-operations/${id}` }, 202);
    }
    release(s, t);
    return c.json({ success: true, message: "approved", data: { payment_tx: t.payment_tx } });
  });
  app.post("/api/v1/submissions/:sid/reject", async (c) => {
    const s = sub(c.req.param("sid"));
    if (!s || !own(c, s.task_id)) return c.json({ error: "FORBIDDEN", message: "not the publisher" }, 403);
    const { notes, severity } = await c.req.json();
    st.rejects.push({ submissionId: s.id, notes, severity, opened: st.opened.has(s.id) });
    if (knobs.staleReject) return c.json({ success: true, message: "rejected" });
    s.agent_verdict = "rejected";
    s.status = "rejected";
    st.tasks.get(s.task_id)!.status = "in_progress"; // minor: the same worker delivers again
    return c.json({ success: true, message: "rejected" });
  });
  app.post("/api/v1/tasks/:id/cancel", (c) => {
    const t = own(c, c.req.param("id"));
    if (!t) return c.json({ error: "FORBIDDEN", message: "only the publisher" }, 403);
    if (t.status !== "published") return c.json({ detail: { code: "TASK_NOT_CANCELLABLE" } }, 409);
    t.status = "cancelled";
    st.cancels.push(t.id);
    return c.json({ success: true, message: "cancelled" });
  });
  app.get("/api/v1/settlement-operations/:op", (c) => {
    const op = st.ops.get(c.req.param("op"));
    if (!op) return c.json({ error: "NOT_FOUND" }, 404);
    return c.json({
      operation_id: c.req.param("op"),
      kind: "approve",
      status: op.state,
      state: op.state,
      done: op.done,
      poll: `/api/v1/settlement-operations/${c.req.param("op")}`,
      next_step: "poll",
      response: op.done && op.state === "succeeded" ? { success: true, data: { payment_tx: op.task.payment_tx } } : null,
    });
  });

  function release(s: Any, t: Any) {
    s.agent_verdict = "accepted";
    s.status = "accepted";
    t.status = "completed";
    t.payment_tx = "0x" + "f0".repeat(32);
  }
  function manifest(evidence: Any | null) {
    if (!evidence) return { items: [], files: [], files_total: 0 };
    const items = Object.entries(evidence).map(([field, v]) => ({
      field,
      type: typeof v === "string" ? "text" : "object",
      size_bytes: Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v)),
      files: [],
    }));
    return { items, files: [], files_total: 0, content_hash: null };
  }

  // the double's fetch: in process, and honouring the caller's abort signal like a real fetch
  const fetch: Fetch = (url, init = {}) => {
    st.fetches++;
    const res = Promise.resolve(app.fetch(new Request(url, init)));
    const signal = init.signal;
    if (!signal) return res;
    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      res.then(resolve, reject);
    });
  };

  return {
    st,
    knobs,
    fetch,
    /** a worker applies (EM's ranking fields included) */
    apply(taskId: string, a: { wallet: string; score?: number; review?: Any | null; executorId?: string; status?: string }) {
      const row = {
        id: randomUUID(),
        task_id: taskId,
        executor_id: a.executorId ?? randomUUID(),
        status: a.status ?? "pending",
        created_at: new Date(clock()).toISOString(),
        wallet_address: a.wallet,
        effective_reputation_score: a.score ?? 0,
        review: a.review ?? null,
      };
      st.apps.get(taskId)!.push(row);
      return row.executor_id;
    },
    /** the assigned worker delivers */
    deliver(taskId: string, evidence: Any) {
      const t = st.tasks.get(taskId)!;
      const s = { id: randomUUID(), task_id: taskId, executor_id: t.executor_id, status: "pending", agent_verdict: null, submitted_at: new Date(clock()).toISOString(), evidence, notes: null };
      st.subs.get(taskId)!.push(s);
      t.status = "submitted";
      return s.id;
    },
    /** an asynchronous lock lands, or fails and EM puts the task back */
    lock(taskId: string, lands: boolean) {
      const t = st.tasks.get(taskId)!;
      if (lands) {
        t.status = "accepted";
        t.escrow_tx = "0x" + "e5".repeat(32);
      } else {
        t.status = "published";
        t.executor_id = null;
        t.escrow_lock_failure = { code: "LOCK_REVERTED", reason: "the token refused the authorization", retryable: true };
      }
    },
    /** queued approvals finish */
    settle(state: "succeeded" | "failed" | "unresolved") {
      for (const op of st.ops.values()) {
        if (op.done) continue;
        op.done = true;
        op.state = state;
        if (state === "succeeded") release(op.submission, op.task);
        else op.submission.agent_verdict = null;
      }
    },
    /** nobody reviewed in time: EM releases the escrow to the worker on its own */
    autoRelease(taskId: string) {
      const s = st.subs.get(taskId)!.find((x) => x.status === "pending")!;
      release(s, st.tasks.get(taskId)!);
    },
    expire(taskId: string) {
      st.tasks.get(taskId)!.status = "expired";
    },
  };
}

// the builder the SDK would be on Robinhood, where it has no escrow row yet: the same wrapper, signed by the signer
const testBuild: BuildPreAuth = async (signer, p) => {
  const n = p.networkConfig;
  const nowS = Math.floor(clock() / 1000);
  const pi = {
    operator: n.operator,
    receiver: p.workerWallet,
    token: n.usdc,
    maxAmount: String(p.bountyAtomic),
    preApprovalExpiry: nowS + 3600,
    authorizationExpiry: (p.reviewDeadlineSec ?? nowS) + 7 * 86400,
    refundExpiry: (p.reviewDeadlineSec ?? nowS) + 14 * 86400,
    minFeeBps: n.min_fee_bps ?? 0,
    maxFeeBps: n.max_fee_bps ?? 1800,
    feeReceiver: n.operator,
    salt: hexlify(randomBytes(32)),
  };
  const message = { from: p.payerWallet, to: n.token_collector, value: String(p.bountyAtomic), validAfter: "0", validBefore: String(pi.preApprovalExpiry), nonce: computeEscrowNonce(n.chain_id, n.escrow, n.payment_info_typehash, pi) };
  const td = {
    domain: { name: n.usdc_domain_name, version: n.usdc_domain_version, chainId: n.chain_id, verifyingContract: n.usdc },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ReceiveWithAuthorization: RECEIVE,
    },
    primaryType: "ReceiveWithAuthorization",
    message,
  };
  const { signature } = await signer.signTypedData(JSON.stringify(td));
  return JSON.stringify({ x402Version: 2, scheme: "escrow", payload: { authorization: message, signature, paymentInfo: pi }, paymentRequirements: { scheme: "escrow", network: `eip155:${n.chain_id}` } });
};

// ---------------------------------------------------------------------------------------------------------------
const servers: { close: () => void }[] = [];
const dirs: string[] = [];
let facUrl = "";
// its own port range: test files run in parallel (app 30000-36999, settle 37000-40999, chain 41000-43999, buyer 44000-47999)
let nextPort = 48000 + Math.floor(Math.random() * 1000);

before(() => {
  const port = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port }));
  facUrl = `http://127.0.0.1:${port}`;
});
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  sent.length = 0;
  sendFails = false;
  clockMs = Date.now();
  merchantUsdg = 10n ** 9n;
});

function baseEnv(dir: string, env: Record<string, string>) {
  return {
    PAY_TO: payTo,
    FACILITATOR_URL: facUrl,
    DATA_DIR: dir,
    WIF_ADDRESS: "0x00000000000000000000000000000000000000f1",
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: merchant.privateKey,
    ...env,
  };
}

interface Setup {
  cfg: Config & { em: EmConfig };
  store: Store;
  em: ReturnType<typeof emDouble>;
  hire: ReturnType<typeof createEmHire>;
  app: ReturnType<typeof createApp>;
  logs: string[];
}

// the merchant's USDG on the chain double
let merchantUsdg = 10n ** 9n;

/** the app with Execution Market switched on, after the first check of EM (as `start()` does at boot) */
async function setup(
  env: Record<string, string> = {},
  opts: { build?: BuildPreAuth; timeoutMs?: number; publishWaitMs?: number; sdkRow?: (chainId: number) => boolean; check?: boolean } = {},
): Promise<Setup> {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-em-"));
  dirs.push(dir);
  const loaded = loadConfig(baseEnv(dir, { ...EM_ENV, ...env }));
  const cfg = { ...loaded, em: loaded.em! };
  const store = new Store(dir);
  const em = emDouble();
  const logs: string[] = [];
  const now = () => new Date(clock());
  const api = emClient({ apiUrl: cfg.em.apiUrl, wallet: merchant, chainId: cfg.chain.chainId, fetch: em.fetch, timeoutMs: opts.timeoutMs ?? 5000 });
  const hire = createEmHire({
    cfg,
    store,
    api,
    sendWif: budgetedWif(cfg, chain, store, now),
    merchant: merchant.address,
    paymentAuth: (pc, worker, deadline) => escrowPaymentAuth({ cfg, wallet: merchant, build: opts.build ?? testBuild }, pc, worker, deadline),
    // the SDK has no Robinhood row yet; the tests that are not about that stand in for it
    ready: (pc) => escrowReadiness(cfg, pc, opts.sdkRow ?? (() => true)),
    usdgBalance: async () => merchantUsdg,
    log: (m) => logs.push(m),
    now,
  });
  const app = createApp({ cfg, chain, store, emHire: hire, log: (m) => logs.push(m), now, publishWaitMs: opts.publishWaitMs ?? 5000, cashbackWaitMs: 2000 });
  if (opts.check !== false) await hire.tick();
  return { cfg, store, em, hire, app, logs };
}

const call = (app: { fetch: (r: Request) => Response | Promise<Response> }, p: string, init: RequestInit = {}) => Promise.resolve(app.fetch(new Request(`http://flatfee.test${p}`, init)));

/** buys a hire as `wallet`, at the price its tier is quoted */
async function buy(app: Setup["app"], wallet: BaseWallet, request: string) {
  const json = { "content-type": "application/json", "x-payer": wallet.address };
  const first = await call(app, "/api/hire", { method: "POST", headers: json, body: JSON.stringify({ request }) });
  assert.equal(first.status, 402);
  const accept = ((await first.json()) as { accepts: Any[] }).accepts[0];
  const typed = typedDataFor(accept, wallet.address);
  const sig = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const r = await call(app, "/api/hire", { method: "POST", headers: { ...json, "X-PAYMENT": paymentHeader(accept, typed, sig) }, body: JSON.stringify({ request }) });
  return { status: r.status, body: (await r.json()) as Any };
}

const task = (s: Setup, id: string) => s.store.task(id)!;

// ---------------------------------------------------------------------------------------------------------------
test("EM_HIRE is off unless switched on, and on it needs its API, its contracts and the merchant wallet", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-em-cfg-"));
  dirs.push(dir);
  const env = (e: Record<string, string>) => baseEnv(dir, e);
  assert.equal(loadConfig(env({ WORKER_TOKEN: "secret" })).em, null);
  for (const off of ["off", "OFF", " false ", "0", "no", ""]) assert.equal(loadConfig(env({ ...EM_ENV, WORKER_TOKEN: "secret", EM_HIRE: off })).em, null, `"${off}" is off`);
  for (const on of ["on", "ON", " true", "1", "Yes"]) assert.ok(loadConfig(env({ ...EM_ENV, EM_HIRE: on })).em, `"${on}" is on`);
  for (const bad of ["maybe", "onn", "2"]) assert.throws(() => loadConfig(env({ ...EM_ENV, WORKER_TOKEN: "secret", EM_HIRE: bad })), /EM_HIRE must be on or off/);

  const c = loadConfig(env(EM_ENV)).em!;
  assert.equal(c.apiUrl, "https://em.test");
  assert.equal(c.bounty, 200_000n);
  assert.equal(c.deadlineHours, 24);
  assert.equal(c.pollSeconds, 30);
  assert.equal(c.paymentToken, "USDG");
  assert.equal(c.reputationNetwork, null);
  assert.equal(c.escrow.tokenCollector, getAddress(CONTRACTS.tokenCollector));
  assert.equal(loadConfig(env({ ...EM_ENV, EM_API_URL: "HTTPS://EM.Test/" })).em!.apiUrl, "https://em.test");
  assert.equal(loadConfig(env({ ...EM_ENV, EM_API_URL: "http://127.0.0.1:8000" })).em!.apiUrl, "http://127.0.0.1:8000");
  assert.equal(loadConfig(env({ ...EM_ENV, EM_REPUTATION_NETWORK: " Robinhood " })).em!.reputationNetwork, "robinhood");

  const refused: Record<string, string>[] = [
    { EM_API_URL: "" },
    { EM_API_URL: "http://em.test" },
    { EM_API_URL: "ftp://em.test" },
    { EM_API_URL: "https://user:pw@em.test" },
    { EM_API_URL: "https://em.test/api/v1" },
    { EM_API_URL: "https://em.test/?k=1" },
    { EM_API_URL: "not a url" },
    { MERCHANT_PRIVATE_KEY: "", WIF_CASHBACK: "0", WIF_WORKER_REWARD: "0" },
    { EM_BOUNTY_USDG: "0" },
    { EM_BOUNTY_USDG: "0.26" }, // above the holder price of a hire (0.25)
    { EM_BOUNTY_USDG: "-1" },
    { EM_BOUNTY_USDG: "0.0000001" },
    { EM_ESCROW_ADDRESS: "" },
    { EM_OPERATOR_ADDRESS: "0x12" },
    { EM_TOKEN_COLLECTOR_ADDRESS: "0x0000000000000000000000000000000000000000" },
    { EM_DEADLINE_HOURS: "0" },
    { EM_DEADLINE_HOURS: "721" },
    { EM_DEADLINE_HOURS: "1.5" },
    { EM_POLL_SECONDS: "4" },
    { EM_PAYMENT_TOKEN: "US DG" },
    { EM_REPUTATION_NETWORK: "near;drop" },
  ];
  for (const bad of refused) assert.throws(() => loadConfig(env({ ...EM_ENV, ...bad })), ConfigError, JSON.stringify(bad));
  // a pasted key in the URL variable is not repeated in the error
  assert.throws(() => loadConfig(env({ ...EM_ENV, EM_API_URL: "https://k:" + merchant.privateKey.slice(2) + "@em.test" })), (e: Error) => !e.message.includes(merchant.privateKey.slice(2)));
  // the board needs WORKER_TOKEN for its reward; through Execution Market Flat Fee approves the work itself
  assert.throws(() => loadConfig(env({ WORKER_TOKEN: "" })), ConfigError);
  assert.ok(loadConfig(env({ ...EM_ENV, WORKER_TOKEN: "" })).em);
});

test("knob off: /api/hire puts the task on the board exactly as before, and Execution Market is never called", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-em-off-"));
  dirs.push(dir);
  const cfg = loadConfig(baseEnv(dir, { WORKER_TOKEN: "secret" }));
  const em = emDouble();
  const app = createApp({ cfg, chain, store: new Store(dir), log: () => {}, cashbackWaitMs: 2000 });
  const r = await buy(app, buyer, "photo of the menu");
  assert.equal(r.status, 201);
  assert.equal(r.body.task.status, "open");
  assert.equal(r.body.task.via, undefined);
  assert.equal(r.body.task.em, undefined);
  assert.equal(r.body.via, undefined);
  const info = (await (await call(app, "/api/info")).json()) as Any;
  assert.deepEqual(info.hire, { via: "board" });
  const claim = await call(app, `/api/tasks/${r.body.task.id}/claim`, { method: "POST", headers: { "content-type": "application/json", "x-worker-token": "secret" }, body: JSON.stringify({ worker: Wallet.createRandom().address }) });
  assert.equal(claim.status, 200);
  assert.equal(em.st.fetches, 0);
  // a driver without the switch, or the switch without a driver, does not start
  const on = await setup();
  assert.throws(() => createApp({ cfg, chain, store: new Store(dir), emHire: on.hire }), /EM_HIRE is off/);
  assert.throws(() => createApp({ cfg: on.cfg, chain, store: new Store(dir) }), /needs the Execution Market driver/);
});

test("knob on: a paid hire is published on Execution Market, assigned with a USDG escrow, approved, and the worker gets 50 $WIF", async () => {
  const s = await setup({ WORKER_TOKEN: "secret" });
  // a holder pays the holder price and gets the cashback, as on the board
  const r = await buy(s.app, holder, "Is the cafe on 5th street open?");
  assert.equal(r.status, 201);
  assert.equal(r.body.via, "execution-market");
  assert.equal(r.body.receipt.paid, "0.25 USDG");
  assert.equal(r.body.receipt.tier, "holder");
  assert.deepEqual(sent, [{ to: holder.address, amount: 10n * WIF }]);
  const id = r.body.task.id as string;
  assert.equal(r.body.task.via, "em");
  assert.equal(r.body.task.status, "open");
  assert.equal(r.body.task.em.step, "published");
  const emId = r.body.task.em.taskId as string;
  assert.ok(s.em.st.tasks.has(emId));

  // what Flat Fee asked Execution Market for, signed by the merchant wallet, once per task
  assert.equal(s.em.st.creates.length, 1);
  const { body, key } = s.em.st.creates[0];
  assert.equal(key, `flatfee-${id}`);
  assert.equal(body.payment_network, "robinhood-testnet");
  assert.equal(body.payment_token, "USDG");
  assert.equal(body.bounty_usd, 0.2);
  assert.deepEqual(body.evidence_required, ["text_response"]);
  assert.equal(body.target_executor, "human");
  assert.equal(body.deadline_hours, 24);
  assert.equal(body.reputation_network, undefined);
  assert.match(body.instructions, /Is the cafe on 5th street open\?/);
  assert.ok(body.title.length >= 5 && body.instructions.length >= 20);

  // the board never takes a task that runs on Execution Market, whatever its state
  const board = (action: string, worker: string) =>
    call(s.app, `/api/tasks/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-worker-token": "secret" }, body: JSON.stringify({ worker, answer: "x" }) });
  assert.equal((await board("claim", Wallet.createRandom().address)).status, 409);
  assert.equal(task(s, id).status, "open");

  // nobody yet: nothing happens
  await s.hire.tick();
  assert.equal(s.em.st.assigns.length, 0);
  assert.equal(task(s, id).em!.step, "published");

  // applicants: the buyer itself, the merchant, one EM flagged, a low score and a high score
  const good = Wallet.createRandom();
  s.em.apply(emId, { wallet: holder.address.toLowerCase(), score: 99 });
  s.em.apply(emId, { wallet: merchant.address, score: 99 });
  s.em.apply(emId, { wallet: Wallet.createRandom().address, score: 99, review: { level: "blocked" } });
  s.em.apply(emId, { wallet: Wallet.createRandom().address, score: 99, status: "rejected" });
  s.em.apply(emId, { wallet: Wallet.createRandom().address, score: 10 });
  const chosen = s.em.apply(emId, { wallet: good.address, score: 80 });
  await s.hire.tick();
  assert.equal(s.em.st.assigns.length, 1);
  assert.equal(s.em.st.assigns[0].executorId, chosen);
  assert.equal(s.em.st.tasks.get(emId)!.status, "accepted");
  let t = task(s, id);
  assert.equal(t.status, "claimed");
  assert.equal(t.worker, good.address);
  assert.equal(t.em!.step, "assigned");
  assert.equal(t.em!.workerWallet, good.address);
  // not even the assigned worker can complete it on the board and collect the $WIF there
  sent.length = 0;
  assert.equal((await board("complete", good.address)).status, 409);
  assert.equal((await board("claim", good.address)).status, 409);
  assert.equal(task(s, id).status, "claimed");
  assert.equal(sent.length, 0);

  // the worker delivers; Flat Fee opens it, approves it, the escrow pays, and the $WIF goes to the escrow's receiver
  sent.length = 0;
  const sid = s.em.deliver(emId, { text_response: "  Open until 9pm, the menu is on the door.  " });
  await s.hire.tick();
  assert.deepEqual(s.em.st.approvals, [sid]);
  assert.ok(s.em.st.opened.has(sid));
  t = task(s, id);
  assert.equal(t.status, "done");
  assert.equal(t.answer, "Open until 9pm, the menu is on the door.");
  assert.equal(t.em!.step, "completed");
  assert.equal(t.em!.paymentTx, "0x" + "f0".repeat(32));
  assert.equal(t.rewardTx, "0x" + "cd".repeat(32));
  assert.deepEqual(sent, [{ to: good.address, amount: 50n * WIF }]);

  // the buyer reads the answer on the poll link; nothing more happens, and the board cannot touch the task
  const polled = (await (await call(s.app, `/api/tasks/${id}`)).json()) as Any;
  assert.equal(polled.answer, "Open until 9pm, the menu is on the door.");
  await s.hire.tick();
  assert.equal(sent.length, 1);
  assert.equal(s.em.st.approvals.length, 1);
  for (const action of ["claim", "complete"]) {
    const res = await call(s.app, `/api/tasks/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-worker-token": "secret" }, body: JSON.stringify({ worker: good.address, answer: "x" }) });
    assert.equal(res.status, 409);
  }
  // every request to Execution Market was signed by the merchant wallet
  assert.ok(s.em.st.calls.length > 5);
  assert.ok(s.em.st.calls.every((c) => c.wallet === merchant.address));
  const info = (await (await call(s.app, "/api/info")).json()) as Any;
  assert.deepEqual(info.hire, { via: "execution-market", bounty: "0.2", deadlineHours: 24 });
  assert.ok(!JSON.stringify(info).includes(merchant.privateKey.slice(2)));
});

test("a delivery without a usable text answer is rejected with the reason, before it is opened; the next one is approved", async () => {
  const s = await setup();
  const r = await buy(s.app, buyer, "Count the chairs at the bus stop");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  const worker = Wallet.createRandom();
  s.em.apply(emId, { wallet: worker.address });
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "assigned");

  sent.length = 0;
  const photoOnly = s.em.deliver(emId, { photo: "ipfs://bafy" });
  await s.hire.tick();
  const tooLong = s.em.deliver(emId, { text_response: "x".repeat(MAX_ANSWER_BYTES + 1) });
  await s.hire.tick();
  const blank = s.em.deliver(emId, { text_response: { type: "text_response", value: "   " } });
  await s.hire.tick();
  assert.deepEqual(
    s.em.st.rejects.map((x) => [x.submissionId, x.severity, x.opened]),
    [
      [photoOnly, "minor", false],
      [tooLong, "minor", false],
      // the manifest shows a field of some size, so only reading it tells: opened, then rejected
      [blank, "minor", true],
    ],
  );
  assert.match(s.em.st.rejects[0].notes, /text_response/);
  assert.match(s.em.st.rejects[1].notes, /longer than 2000 bytes/);
  assert.equal(s.em.st.approvals.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(task(s, id).status, "claimed");
  assert.equal(task(s, id).em!.rejected.length, 3);
  assert.equal(task(s, id).em!.rejected[0].reason, s.em.st.rejects[0].notes);

  // a listing that still shows a rejected delivery as pending does not get it rejected twice, nor approved
  s.em.knobs.staleReject = true;
  s.em.deliver(emId, { photo: "ipfs://again" });
  await s.hire.tick();
  await s.hire.tick();
  assert.equal(s.em.st.rejects.length, 4);
  assert.equal(s.em.st.approvals.length, 0);
  s.em.knobs.staleReject = false;
  for (const x of s.em.st.subs.get(emId)!) if (x.status === "pending") Object.assign(x, { status: "rejected", agent_verdict: "rejected" });

  const good = s.em.deliver(emId, { text_response: { type: "text_response", value: "Four chairs." } });
  await s.hire.tick();
  assert.deepEqual(s.em.st.approvals, [good]);
  assert.equal(task(s, id).answer, "Four chairs.");
  assert.deepEqual(sent, [{ to: worker.address, amount: 50n * WIF }]);
});

test("timeout: nobody is assigned before the deadline, so the task is cancelled on Execution Market and expires, unpaid", async () => {
  const s = await setup({ EM_DEADLINE_HOURS: "2" });
  const r = await buy(s.app, buyer, "Walk my dog at noon");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  clockMs += 2 * 3_600_000 - 1000;
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "published");
  clockMs += 2000;
  s.em.apply(emId, { wallet: Wallet.createRandom().address }); // too late
  sent.length = 0;
  await s.hire.tick();
  assert.deepEqual(s.em.st.cancels, [emId]);
  assert.equal(s.em.st.assigns.length, 0);
  const t = task(s, id);
  assert.equal(t.status, "expired");
  assert.equal(t.em!.step, "expired");
  assert.match(t.em!.lastError!, /deadline/);
  assert.equal(sent.length, 0);
  await s.hire.tick();
  assert.equal(s.em.st.cancels.length, 1);
});

test("timeout: Execution Market does not answer; the error stays on the task, nothing changes, and the next pass goes on", async () => {
  const s = await setup({}, { timeoutMs: 50, publishWaitMs: 1000 });
  s.em.knobs.hang = true;
  const started = Date.now();
  const r = await buy(s.app, buyer, "Read the sign on the door");
  assert.equal(r.status, 201);
  assert.ok(Date.now() - started < 4000, "the paid call waited for Execution Market");
  const id = r.body.task.id as string;
  assert.equal(r.body.task.em.step, "publishing");
  assert.match(task(s, id).em!.lastError!, /did not answer within 50 ms/);
  assert.equal(s.em.st.tasks.size, 0);

  s.em.knobs.hang = false;
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "published");
  assert.equal(task(s, id).em!.lastError, null);
  assert.equal(s.em.st.tasks.size, 1);
  // a publish sent again carries the same key: still one task on Execution Market
  assert.ok(s.em.st.creates.every((c) => c.key === `flatfee-${id}`));
});

test("Execution Market refuses the task at publish: it ends expired with the reason, and nothing is retried", async () => {
  const s = await setup();
  s.em.knobs.refuseCreate = true;
  const r = await buy(s.app, buyer, "Find the cheapest coffee nearby");
  const id = r.body.task.id as string;
  const t = task(s, id);
  assert.equal(t.status, "expired");
  assert.equal(t.em!.step, "failed");
  assert.match(t.em!.lastError!, /422 invalid_payment_token/);
  await s.hire.tick();
  assert.equal(s.em.st.creates.length, 1);
});

test("a queued lock and a queued approval are followed to the end, and the escrow is approved once", async () => {
  const s = await setup();
  s.em.knobs.asyncAssign = true;
  s.em.knobs.asyncApprove = true;
  const r = await buy(s.app, buyer, "Take a photo of the queue");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  const worker = Wallet.createRandom();
  s.em.apply(emId, { wallet: worker.address });
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "assigning");
  assert.equal(task(s, id).status, "open");
  await s.hire.tick();
  assert.equal(s.em.st.assigns.length, 1, "assigned again while the lock was in flight");
  s.em.lock(emId, true);
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "assigned");
  assert.equal(task(s, id).status, "claimed");

  sent.length = 0;
  s.em.deliver(emId, { text_response: "Twelve people." });
  await s.hire.tick();
  assert.equal(task(s, id).em!.step, "approving");
  await s.hire.tick();
  await s.hire.tick();
  assert.equal(s.em.st.approvals.length, 1, "approved again while the release was queued");
  assert.equal(sent.length, 0);
  s.em.settle("succeeded");
  await s.hire.tick();
  assert.equal(task(s, id).status, "done");
  assert.equal(task(s, id).answer, "Twelve people.");
  assert.deepEqual(sent, [{ to: worker.address, amount: 50n * WIF }]);
});

test("a queued approval EM could not settle is approved again; one it cannot account for is never approved again", async () => {
  const s = await setup();
  s.em.knobs.asyncApprove = true;
  const r = await buy(s.app, buyer, "Is the pharmacy open?");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  s.em.apply(emId, { wallet: Wallet.createRandom().address });
  await s.hire.tick();
  s.em.deliver(emId, { text_response: "Yes." });
  await s.hire.tick();
  s.em.settle("failed");
  await s.hire.tick(); // reads the failure
  await s.hire.tick(); // reviews and approves again
  assert.equal(s.em.st.approvals.length, 2);
  s.em.settle("unresolved");
  await s.hire.tick();
  await s.hire.tick();
  assert.equal(s.em.st.approvals.length, 2);
  assert.match(task(s, id).em!.lastError!, /could not tell/);
  assert.notEqual(task(s, id).status, "done");
});

test("an escrow lock that fails puts the task back: that applicant is skipped and the next one gets it", async () => {
  const s = await setup();
  s.em.knobs.lockFails = true;
  const r = await buy(s.app, buyer, "Check the price of bread");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  const first = s.em.apply(emId, { wallet: Wallet.createRandom().address, score: 90 });
  const second = s.em.apply(emId, { wallet: Wallet.createRandom().address, score: 50 });
  await s.hire.tick();
  s.em.lock(emId, false);
  s.em.knobs.lockFails = false;
  await s.hire.tick();
  assert.deepEqual(s.em.st.assigns.map((a) => a.executorId), [first, second]);
  assert.deepEqual(task(s, id).em!.skipped, [first]);
  assert.equal(task(s, id).em!.step, "assigned");
});

test("Execution Market released the escrow on its own: Flat Fee reads the delivery and sends the $WIF once", async () => {
  const s = await setup();
  const r = await buy(s.app, buyer, "Note the bus times");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  const worker = Wallet.createRandom();
  s.em.apply(emId, { wallet: worker.address });
  await s.hire.tick();
  s.em.deliver(emId, { text_response: "Every 10 minutes." });
  s.em.autoRelease(emId);
  sent.length = 0;
  await s.hire.tick();
  await s.hire.tick();
  assert.equal(task(s, id).status, "done");
  assert.equal(task(s, id).answer, "Every 10 minutes.");
  assert.equal(s.em.st.approvals.length, 0);
  assert.deepEqual(sent, [{ to: worker.address, amount: 50n * WIF }]);
});

test("Execution Market expired the assigned task: it ends expired and no $WIF goes out", async () => {
  const s = await setup();
  const r = await buy(s.app, buyer, "Photograph the sunset");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  s.em.apply(emId, { wallet: Wallet.createRandom().address });
  await s.hire.tick();
  s.em.expire(emId);
  sent.length = 0;
  await s.hire.tick();
  assert.equal(task(s, id).status, "expired");
  assert.equal(task(s, id).em!.step, "expired");
  assert.equal(sent.length, 0);
  assert.equal(s.em.st.cancels.length, 0);
});

test("the $WIF reward that cannot go out is recorded; the task is still done and is never paid twice", async () => {
  const s = await setup();
  const r = await buy(s.app, buyer, "Sweep the porch");
  const id = r.body.task.id as string;
  const emId = r.body.task.em.taskId as string;
  s.em.apply(emId, { wallet: Wallet.createRandom().address });
  await s.hire.tick();
  s.em.deliver(emId, { text_response: "Done." });
  sendFails = true;
  await s.hire.tick();
  const t = task(s, id);
  assert.equal(t.status, "done");
  assert.match(t.rewardError!, /out of \$WIF/);
  sendFails = false;
  sent.length = 0;
  await s.hire.tick();
  assert.equal(sent.length, 0);
});

test("the merchant signs no escrow EM publishes for other contracts, and nothing reaches the assignment", async () => {
  const cases: [string, Any][] = [
    ["escrow", { escrow: Wallet.createRandom().address }],
    ["operator", { operator: Wallet.createRandom().address }],
    ["token collector", { token_collector: Wallet.createRandom().address }],
    ["token", { usdc: Wallet.createRandom().address }],
    ["chain", { chain_id: 4663 }],
  ];
  for (const [what, change] of cases) {
    const s = await setup();
    const r = await buy(s.app, buyer, "Water the plants");
    assert.equal(r.status, 201, what);
    // EM changes its published escrow while the task waits for a worker
    s.em.knobs.network = { ...s.em.knobs.network, ...change };
    const emId = r.body.task.em.taskId as string;
    s.em.apply(emId, { wallet: Wallet.createRandom().address });
    await s.hire.tick();
    assert.equal(s.em.st.assigns.length, 0, what);
    assert.match(task(s, r.body.task.id).em!.lastError!, /not the one Flat Fee is configured with|another chain/, what);
    assert.equal(task(s, r.body.task.id).em!.step, "published", what);
    // and nobody else pays for a hire until it is Flat Fee's again
    const next = await call(s.app, "/api/hire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "x" }) });
    assert.equal(next.status, 503, what);
  }
  // the SDK's own builder has no Robinhood row yet: it refuses to sign, so nothing is assigned either
  const s = await setup({}, { build: buildEscrowPreAuth });
  const r = await buy(s.app, buyer, "Water the plants");
  s.em.apply(r.body.task.em.taskId, { wallet: Wallet.createRandom().address });
  await s.hire.tick();
  assert.equal(s.em.st.assigns.length, 0);
  assert.match(task(s, r.body.task.id).em!.lastError!, /escrow builder refused/);
});

test("a hire that could not run on Execution Market is refused before the 402, so nobody pays for it", async () => {
  const refusedBefore402 = async (s: Setup, why: RegExp) => {
    const r = await call(s.app, "/api/hire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "a small task" }) });
    assert.equal(r.status, 503);
    const body = (await r.json()) as Any;
    assert.match(body.error, why);
    assert.equal(r.headers.get("payment-required"), null);
    assert.equal(s.em.st.creates.length, 0);
    // asking the agent is not affected
    assert.equal((await call(s.app, "/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "help" }) })).status, 402);
  };
  // before the first check answers
  await refusedBefore402(await setup({}, { check: false }), /not been checked yet/);
  // the SDK cannot sign an escrow on this chain
  await refusedBefore402(await setup({}, { sdkRow: () => false }), /no escrow row for robinhood-testnet/);
  // EM lists its tokens there and USDG is not one of them
  const t = await setup({}, { check: false });
  t.em.knobs.network = { ...t.em.knobs.network, tokens: { USDC: { address: USDG } } };
  await t.hire.tick();
  await refusedBefore402(t, /does not take USDG/);
  // the merchant cannot fund one bounty
  merchantUsdg = 199_999n;
  await refusedBefore402(await setup(), /less than one bounty/);
  merchantUsdg = 200_000n;
  const ok = await setup();
  assert.equal(ok.hire.unavailable(), null);
  // an unreachable EM later keeps the last answer: a hire paid now is published once EM answers again
  const slow = await setup({}, { timeoutMs: 50 });
  slow.em.knobs.hang = true;
  await slow.hire.refresh();
  assert.equal(slow.hire.unavailable(), null);
  assert.ok(slow.logs.some((l) => /check failed/.test(l)));
  // the SDK's table, read the way its builder reads it
  assert.equal(sdkHasEscrowRow(8453), true);
  assert.equal(sdkHasEscrowRow(999_999), false);
});

// ---------------------------------------------------------------------------------------------------------------
const emCfg = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-em-unit-"));
  dirs.push(dir);
  const c = loadConfig(baseEnv(dir, EM_ENV));
  return { ...c, em: c.em! };
})();
const paymentConfig = (network: Any = {}) => ({
  escrow: {
    payment_info_typehash: ESCROW_PAYMENT_INFO_TYPEHASH,
    min_fee_bps: 0,
    max_fee_bps: 1800,
    tier_timings: { micro: { pre: 3600, auth: 7200, refund: 86400 } },
    networks: { "robinhood-testnet": { chain_id: CHAIN_ID, usdc: USDG, escrow: CONTRACTS.escrow, operator: CONTRACTS.operator, token_collector: CONTRACTS.tokenCollector, ...network } },
  },
});

test("escrowNetwork takes EM's parameters only when they are Flat Fee's own, any address case", () => {
  const n = escrowNetwork(emCfg, paymentConfig({ escrow: CONTRACTS.escrow.toLowerCase(), token_collector: CONTRACTS.tokenCollector.toUpperCase().replace("0X", "0x") }));
  assert.equal(n.chain_id, CHAIN_ID);
  assert.equal(n.usdc, USDG);
  assert.equal(n.usdc_domain_name, "Global Dollar");
  assert.equal(n.usdc_domain_version, "1");
  assert.deepEqual(n.tiers, { micro: { pre: 3600, auth: 7200, refund: 86400 } });
  // USDG may come in the tokens map instead of `usdc`
  assert.equal(escrowNetwork(emCfg, paymentConfig({ usdc: undefined, tokens: { USDG: { address: USDG } } })).usdc, USDG);
  const refused: (Any | null)[] = [
    paymentConfig({ chain_id: 4663 }),
    paymentConfig({ chain_id: "46630" }),
    paymentConfig({ usdc: MAINNET_USDG }),
    paymentConfig({ usdc: undefined }),
    paymentConfig({ escrow: "0x12" }),
    paymentConfig({ operator: null }),
    paymentConfig({ token_collector: CONTRACTS.escrow }),
    { escrow: { ...paymentConfig().escrow, payment_info_typehash: "0x" + "00".repeat(32) } },
    { escrow: { ...paymentConfig().escrow, networks: {} } },
    {},
    null,
  ];
  for (const pc of refused) assert.throws(() => escrowNetwork(emCfg, pc), EscrowRefused, JSON.stringify(pc));
});

test("checkPaymentAuth passes the lock of the bounty for the worker, and refuses every other shape", async () => {
  const worker = Wallet.createRandom().address;
  const deadline = Math.floor(clock() / 1000) + 86400;
  const good = await escrowPaymentAuth({ cfg: emCfg, wallet: merchant, build: testBuild }, paymentConfig(), worker, deadline);
  checkPaymentAuth(emCfg, merchant.address, worker, good);
  const w = JSON.parse(good);
  const resign = async (mutate: (x: Any) => void) => {
    // re-signed by the merchant, so only the field under test is wrong
    const x = JSON.parse(good);
    mutate(x);
    const domain = { name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: USDG };
    x.payload.signature = await merchant.signTypedData(domain, { ReceiveWithAuthorization: RECEIVE }, x.payload.authorization);
    return JSON.stringify(x);
  };
  const other = Wallet.createRandom();
  const bad: [string, string][] = [
    ["not JSON", "{"],
    ["exact scheme", JSON.stringify({ ...w, scheme: "exact" })],
    ["exact requirement", JSON.stringify({ ...w, paymentRequirements: { ...w.paymentRequirements, scheme: "exact" } })],
    ["mainnet", JSON.stringify({ ...w, paymentRequirements: { ...w.paymentRequirements, network: "eip155:4663" } })],
    ["more USDG", await resign((x) => (x.payload.authorization.value = "200001"))],
    ["to the worker", await resign((x) => (x.payload.authorization.to = worker))],
    ["another receiver", await resign((x) => (x.payload.paymentInfo.receiver = other.address))],
    ["another max", await resign((x) => (x.payload.paymentInfo.maxAmount = "999999"))],
    ["another token", await resign((x) => (x.payload.paymentInfo.token = MAINNET_USDG))],
    ["another operator", await resign((x) => (x.payload.paymentInfo.operator = other.address))],
    ["another salt", await resign((x) => (x.payload.paymentInfo.salt = hexlify(randomBytes(32))))],
    ["another payer", await resign((x) => (x.payload.authorization.from = other.address))],
    ["signed by another key", JSON.stringify({ ...w, payload: { ...w.payload, signature: await other.signTypedData({ name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: USDG }, { ReceiveWithAuthorization: RECEIVE }, w.payload.authorization) } })],
    ["no signature", JSON.stringify({ ...w, payload: { ...w.payload, signature: undefined } })],
  ];
  for (const [what, raw] of bad) assert.throws(() => checkPaymentAuth(emCfg, merchant.address, worker, raw), EscrowRefused, what);
  // a builder that returns anything else is refused before the authorization leaves Flat Fee
  const evil: BuildPreAuth = async (signer, p) => (await testBuild(signer, { ...p, workerWallet: other.address }));
  await assert.rejects(escrowPaymentAuth({ cfg: emCfg, wallet: merchant, build: evil }, paymentConfig(), worker, deadline), EscrowRefused);
});

test("the SDK's own escrow builder signs through Flat Fee's signer: the authorization is the merchant's", async () => {
  // Base has a row in the SDK's tables, so its real builder runs end to end here
  const c = ESCROW_CONTRACTS[8453]!;
  const domain = VERIFIED_USDC_DOMAINS[8453]!;
  const raw = await buildEscrowPreAuth(typedDataSigner(merchant), {
    networkConfig: {
      chain_id: 8453,
      operator: String((ESCROW_OPERATORS as Record<number, unknown>)[8453]),
      escrow: c.escrow,
      token_collector: c.tokenCollector,
      usdc: c.usdc,
      usdc_domain_name: domain.name,
      usdc_domain_version: domain.version,
      payment_info_typehash: ESCROW_PAYMENT_INFO_TYPEHASH,
    },
    network: "base",
    payerWallet: merchant.address,
    workerWallet: buyer.address,
    bountyAtomic: "200000",
    reviewDeadlineSec: Math.floor(Date.now() / 1000) + 86400,
  });
  const w = JSON.parse(raw);
  const a = w.payload.authorization;
  const signer = verifyTypedData({ name: domain.name, version: domain.version, chainId: 8453, verifyingContract: c.usdc }, { ReceiveWithAuthorization: RECEIVE }, a, w.payload.signature);
  assert.equal(signer, merchant.address);
  assert.equal(a.nonce, computeEscrowNonce(8453, c.escrow, ESCROW_PAYMENT_INFO_TYPEHASH, w.payload.paymentInfo));
});

test("the client signs every request so EM's verifier accepts it; the double refuses what is not signed", async () => {
  const em = emDouble();
  const unsigned = await em.fetch("https://em.test/api/v1/tasks/" + randomUUID());
  assert.equal(unsigned.status, 401);
  const api = emClient({ apiUrl: "https://em.test", wallet: merchant, chainId: CHAIN_ID, fetch: em.fetch });
  const created = await api.createTask({ title: "Flat Fee: x", instructions: "x".repeat(20), deadline_hours: 1, bounty_usd: 0.2 }, "k1");
  assert.equal((await api.getTask(created.id)).status, "published");
  // another wallet is not the publisher
  const stranger = emClient({ apiUrl: "https://em.test", wallet: Wallet.createRandom(), chainId: CHAIN_ID, fetch: em.fetch });
  await assert.rejects(stranger.getTask(created.id), (e: EmHttpError) => e.status === 404 && !e.retryable);
  // nothing that is not a UUID goes into a path, and a poll path is only ever EM's settlement operations
  const before = em.st.fetches;
  await assert.rejects(api.getTask("../admin"), (e: EmHttpError) => e.code === "bad_id");
  await assert.rejects(api.cancel("00000000-0000-0000-0000-00000000000g", "x"), (e: EmHttpError) => e.code === "bad_id");
  await assert.rejects(api.operation("https://elsewhere.test/x"), (e: EmHttpError) => e.code === "bad_poll");
  await assert.rejects(api.operation("/api/v1/tasks/" + randomUUID()), (e: EmHttpError) => e.code === "bad_poll");
  assert.equal(em.st.fetches, before, "a request went out");
  assert.equal(new EmHttpError(503, null, "x").retryable, true);
  assert.equal(new EmHttpError(409, "identity_registering", "x").retryable, true);
  assert.equal(new EmHttpError(409, "idempotency_key_spent", "x").retryable, false);
  assert.equal(new EmHttpError(0, "timeout", "x").retryable, true);
});

test("the review reads the manifest and the text the way Execution Market hands them over", () => {
  const sub = (items: Any[] | undefined) => ({ id: randomUUID(), task_id: "t", executor_id: "e", status: "pending", evidence_manifest: items ? { items } : null });
  assert.equal(manifestProblem(sub(undefined)), null);
  assert.equal(manifestProblem(sub([{ field: "text_response", size_bytes: 12 }])), null);
  assert.equal(manifestProblem(sub([{ field: "text_response", size_bytes: MAX_ANSWER_BYTES }])), null);
  assert.match(manifestProblem(sub([{ field: "photo", size_bytes: 12 }]))!, /No text_response/);
  assert.match(manifestProblem(sub([{ field: "text_response", size_bytes: 0 }]))!, /empty/);
  assert.match(manifestProblem(sub([{ field: "text_response", size_bytes: MAX_ANSWER_BYTES + 1 }]))!, /longer/);
  assert.equal(answerOf({ text_response: " yes " }), "yes");
  assert.equal(answerOf({ text_response: { type: "text_response", value: "no" } }), "no");
  assert.equal(answerOf({ text_response: { text: "maybe" } }), "maybe");
  assert.equal(answerOf({ text_response: "   " }), null);
  assert.equal(answerOf({ text_response: 42 }), null);
  assert.equal(answerOf({ photo: "ipfs://x" }), null);
  assert.equal(answerOf(null), null);
  assert.equal(answerOf({ text_response: "é".repeat(MAX_ANSWER_BYTES + 5) })!.length, MAX_ANSWER_BYTES);
});
