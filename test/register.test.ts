// `npm run em:register` (scripts/lib/register.ts) against a double of Execution Market's registration routes: no
// network. The double checks the registration's ERC-8128 signature with the SDK's verifier and counts every one it
// gets: a wallet is registered at most once, and only with CONFIRM_EM_REGISTER.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { Wallet, getAddress } from "ethers";
import { policyFromPreset, verifyRequest, type NonceStore } from "uvd-x402-sdk/erc8128";
import { emCaller } from "../scripts/lib/emworker.js";
import { registerPlanRefusal, runRegister, type RegisterDeps, type RegisterPlan } from "../scripts/lib/register.js";

type Any = Record<string, any>;
const URI = "https://flatfee.ultravioletadao.xyz";

function emDouble(merchant: string, start: "none" | "pending" | "registered") {
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
    status: start as string,
    agentId: start === "registered" ? 37500 : (null as number | null),
    registrationId: start === "pending" ? "7f6e5d4c-0000-4000-8000-000000000001" : (null as string | null),
    registrations: [] as { wallet: string; body: Any }[],
    /** polls before the registration resolves, and how */
    pollsLeft: 2,
    resolveAs: "completed" as "completed" | "failed" | "never",
    /** the POST answers 200 at once instead of 202 */
    sync: false,
    polls: 0,
  };
  const app = new Hono();
  app.get("/api/v1/auth/erc8128/nonce", (c) => {
    const n = randomBytes(16).toString("hex");
    issued.add(n);
    return c.json({ nonce: n });
  });
  app.get("/api/v1/reputation/register/wallet/:wallet", (c) => {
    if (c.req.query("network") !== "base") return c.json({ detail: "Unsupported network" }, 400);
    if (c.req.param("wallet").toLowerCase() !== merchant.toLowerCase()) return c.json({ wallet: c.req.param("wallet"), network: "base", status: "none" });
    const poll = st.registrationId ? `/api/v1/reputation/register/${st.registrationId}` : null;
    return c.json({ wallet: merchant.toLowerCase(), network: "base", status: st.status, agent_id: st.agentId, registration_id: st.registrationId, poll });
  });
  app.post("/api/v1/reputation/register", async (c) => {
    const bytes = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const v = await verifyRequest({ method: c.req.method, url: c.req.url, headers: Object.fromEntries(c.req.raw.headers), rawBody: bytes.length ? bytes : undefined }, policy);
    if (!v.ok) return c.json({ error: v.code }, 401);
    st.registrations.push({ wallet: getAddress(v.wallet), body: await c.req.json() });
    if (st.status !== "none") return c.json({ detail: { error: "identity_registering" } }, 409);
    if (st.sync) {
      Object.assign(st, { status: "registered", agentId: 4242 });
      return c.json({ success: true, agent_id: 4242, transaction: "0x" + "ab".repeat(32), owner: v.wallet, network: "base" });
    }
    Object.assign(st, { status: "pending", registrationId: "7f6e5d4c-0000-4000-8000-000000000002" });
    return c.json({ registration_id: st.registrationId, status: "pending", poll: `/api/v1/reputation/register/${st.registrationId}` }, 202);
  });
  app.get("/api/v1/reputation/register/:id", (c) => {
    if (c.req.param("id") !== st.registrationId) return c.json({ detail: "Unknown registration_id" }, 404);
    st.polls++;
    if (st.resolveAs !== "never" && --st.pollsLeft <= 0) {
      if (st.resolveAs === "failed") return c.json({ registration_id: st.registrationId, status: "failed", error: "mint reverted" });
      Object.assign(st, { status: "registered", agentId: 4243 });
      return c.json({ registration_id: st.registrationId, status: "completed", agent_id: 4243, transaction: "0x" + "cd".repeat(32) });
    }
    return c.json({ registration_id: st.registrationId, status: "pending" });
  });
  return { st, fetch: (url: string, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init))) };
}

/** a merchant wallet, EM's double in state `start`, and the same wiring as scripts/em-register.ts */
function setup(start: "none" | "pending" | "registered", tweak: (st: ReturnType<typeof emDouble>["st"]) => void = () => {}) {
  const wallet = Wallet.createRandom();
  const em = emDouble(wallet.address, start);
  tweak(em.st);
  const { call, send } = emCaller({ apiUrl: "https://em.test", auth: { kind: "erc8128", wallet, chainId: 4663, client: null }, fetch: em.fetch });
  let clock = 0;
  const deps: RegisterDeps = {
    get: (p) => send(`https://em.test${p}`, { method: "GET", headers: { accept: "application/json" } }),
    register: (body) => call("POST", "/api/v1/reputation/register", body),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  };
  const plan = (p: Partial<RegisterPlan> = {}): RegisterPlan => ({ merchant: wallet.address, agentUri: URI, confirm: null, pollMs: 5_000, timeoutMs: 60_000, ...p });
  return { wallet, em, deps, plan };
}

test("already registered on Base: nothing is sent, confirmed or not", async () => {
  for (const confirmed of [false, true]) {
    const s = setup("registered");
    const o = await runRegister(s.plan({ confirm: confirmed ? s.wallet.address : null }), s.deps);
    assert.deepEqual([o.ok, o.status, o.agentId, o.sent], [true, "registered", "37500", 0]);
    assert.equal(s.em.st.registrations.length, 0);
  }
});

test("a registration in flight is followed to the end and never sent again, confirmed or not", async () => {
  for (const confirmed of [false, true]) {
    const s = setup("pending");
    const o = await runRegister(s.plan({ confirm: confirmed ? s.wallet.address : null }), s.deps);
    assert.deepEqual([o.ok, o.status, o.agentId, o.sent], [true, "completed", "4243", 0]);
    assert.equal(s.em.st.registrations.length, 0);
    assert.ok(s.em.st.polls >= 2);
  }
});

test("no identity: a dry run unless CONFIRM_EM_REGISTER is the merchant's own address", async () => {
  for (const confirm of [null, "", "yes", "0x1234", Wallet.createRandom().address]) {
    const s = setup("none");
    const o = await runRegister(s.plan({ confirm }), s.deps);
    assert.deepEqual([o.ok, o.status, o.sent], [false, "dry-run", 0], String(confirm));
    assert.equal(s.em.st.registrations.length, 0, String(confirm));
    assert.match(o.message, new RegExp(`CONFIRM_EM_REGISTER=${s.wallet.address}`));
    assert.ok(o.message.includes(`agent_uri: "${URI}"`));
  }
});

test("no identity, confirmed (any case): one registration, signed by the merchant, for Base, followed until completed", async () => {
  for (const form of [(a: string) => a, (a: string) => a.toLowerCase(), (a: string) => ` ${a.toUpperCase().replace("0X", "0x")} `]) {
    const s = setup("none");
    const o = await runRegister(s.plan({ confirm: form(s.wallet.address) }), s.deps);
    assert.deepEqual([o.ok, o.status, o.agentId, o.transaction, o.sent], [true, "completed", "4243", "0x" + "cd".repeat(32), 1]);
    assert.deepEqual(s.em.st.registrations, [{ wallet: s.wallet.address, body: { network: "base", agent_uri: URI } }]);
  }
  // EM may answer at once (200)
  const s = setup("none", (st) => (st.sync = true));
  const o = await runRegister(s.plan({ confirm: s.wallet.address }), s.deps);
  assert.deepEqual([o.ok, o.agentId, o.sent], [true, "4242", 1]);
  assert.equal(s.em.st.registrations.length, 1);
});

test("a registration that fails or does not finish is never sent again; the run says not to", async () => {
  for (const [resolveAs, status] of [["failed", "failed"], ["never", "timeout"]] as const) {
    const s = setup("none", (st) => (st.resolveAs = resolveAs));
    const o = await runRegister(s.plan({ confirm: s.wallet.address, timeoutMs: 30_000 }), s.deps);
    assert.deepEqual([o.ok, o.status, o.sent], [false, status, 1], resolveAs);
    assert.match(o.message, /do NOT register again/);
    // run again later, confirmed: the registration in flight is followed, not sent anew
    const again = await runRegister(s.plan({ confirm: s.wallet.address, timeoutMs: 10_000 }), s.deps);
    assert.equal(again.sent, 0, resolveAs);
    assert.equal(s.em.st.registrations.length, 1, resolveAs);
  }
});

test("an unreadable status, an unknown one, or a poll path that is not EM's own: nothing more is sent", async () => {
  const wallet = Wallet.createRandom();
  const plan: RegisterPlan = { merchant: wallet.address, agentUri: URI, confirm: wallet.address, pollMs: 1, timeoutMs: 1_000 };
  let registered = 0;
  const deps = (get: RegisterDeps["get"]): RegisterDeps => ({
    get,
    register: async () => {
      registered++;
      return { status: 202, body: { poll: "https://elsewhere.example/x" } };
    },
    sleep: async () => {},
    now: () => 0,
    log: () => {},
  });
  assert.equal((await runRegister(plan, deps(async () => { throw new Error("unreachable"); }))).status, "refused");
  assert.equal((await runRegister(plan, deps(async () => ({ status: 200, body: { status: "weird" } })))).status, "refused");
  assert.equal((await runRegister(plan, deps(async () => ({ status: 200, body: { status: "pending", poll: "https://elsewhere.example/x" } })))).status, "refused");
  assert.equal(registered, 0);
  // a 202 that points anywhere but EM's own registration route is not followed
  const o = await runRegister(plan, deps(async () => ({ status: 200, body: { status: "none" } })));
  assert.equal(o.status, "refused");
  assert.equal(registered, 1);
});

test("the plan: an https agent_uri of at most 2048 characters, and an address", () => {
  const m = Wallet.createRandom().address;
  assert.equal(registerPlanRefusal({ merchant: m, agentUri: URI }), null);
  assert.match(registerPlanRefusal({ merchant: m, agentUri: "http://flatfee.ultravioletadao.xyz" })!, /https/);
  assert.match(registerPlanRefusal({ merchant: m, agentUri: "not a url" })!, /not a URL/);
  assert.match(registerPlanRefusal({ merchant: m, agentUri: `https://x.example/${"a".repeat(2048)}` })!, /2048/);
  assert.match(registerPlanRefusal({ merchant: "0x12", agentUri: URI })!, /not an address/);
});
