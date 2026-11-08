// The app with a fake chain and a fake facilitator: no RPC, no network. Payments are signed locally with the same
// builder the landing page uses (public/x402-browser.js).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet, getAddress, verifyTypedData, type BaseWallet, type JsonRpcProvider } from "ethers";
import { createApp, safeMessage, type AppDeps } from "../src/app.js";
import { WifTransferUnconfirmed, type Chain, type Tier } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { paymentHeader, typedDataFor, walletPayBlocked } from "../public/x402-browser.js";

const holder = Wallet.createRandom();
const stranger = Wallet.createRandom();
const worker = Wallet.createRandom();
const payTo = Wallet.createRandom().address;

// fake facilitator, strict like the real one: the signature must recover to `from` over the USDG domain of the
// requirement, and the amount, recipient and network must match it. `facValid = false` makes it refuse for funds.
const facCalls: { path: string; value: string; from: string }[] = [];
let facValid = true;
const fac = new Hono();
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const usedNonces = new Set<string>();
function strictVerify(b: any): { ok: true; from: string } | { ok: false; reason: string; from?: string } {
  const pay = b?.paymentPayload?.payload;
  const a = pay?.authorization;
  const req = b?.paymentRequirements ?? b?.accepted ?? b?.paymentPayload?.accepted;
  if (!a || !req) return { ok: false, reason: "invalid_payload" };
  if (req.network !== "eip155:46630") return { ok: false, reason: "invalid_network", from: a.from };
  if (a.value !== String(req.amount ?? req.maxAmountRequired)) return { ok: false, reason: "invalid_value", from: a.from };
  if (getAddress(a.to) !== getAddress(req.payTo)) return { ok: false, reason: "recipient_mismatch", from: a.from };
  let signer = "";
  try {
    signer = verifyTypedData({ name: req.extra.name, version: req.extra.version, chainId: 46630, verifyingContract: req.asset }, TYPES, a, pay.signature);
  } catch {
    return { ok: false, reason: "invalid_signature", from: a.from };
  }
  if (getAddress(signer) !== getAddress(a.from)) return { ok: false, reason: "invalid_signature", from: a.from };
  if (usedNonces.has(a.nonce)) return { ok: false, reason: "authorization_already_used", from: a.from };
  if (!facValid) return { ok: false, reason: "insufficient_funds", from: a.from };
  return { ok: true, from: a.from };
}
fac.post("/verify", async (c) => {
  const b = await c.req.json();
  const v = strictVerify(b);
  facCalls.push({ path: "verify", value: b?.paymentPayload?.payload?.authorization?.value, from: b?.paymentPayload?.payload?.authorization?.from });
  return c.json(v.ok ? { isValid: true, payer: v.from } : { isValid: false, invalidReason: v.reason, payer: v.from });
});
fac.post("/settle", async (c) => {
  const b = await c.req.json();
  const v = strictVerify(b);
  facCalls.push({ path: "settle", value: b?.paymentPayload?.payload?.authorization?.value, from: b?.paymentPayload?.payload?.authorization?.from });
  if (!v.ok) return c.json({ success: false, errorReason: v.reason, network: "eip155:46630" });
  usedNonces.add(b.paymentPayload.payload.authorization.nonce);
  return c.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:46630", payer: v.from });
});

// fake chain: the holder holds $WIF, nobody else; $WIF sends are recorded (or fail on demand)
const sent: { to: string; amount: bigint }[] = [];
let sendFails = false;
const chain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: "0x00000000000000000000000000000000000000ee",
  balanceOf: async () => 0n,
  tierOf: async (owner: string): Promise<Tier> => (owner.toLowerCase() === holder.address.toLowerCase() ? "holder" : "standard"),
  sendWif: async (to: string, amount: bigint) => {
    if (sendFails) throw new Error("merchant out of $WIF");
    sent.push({ to, amount });
    return { to, amount, tx: "0x" + "cd".repeat(32) };
  },
};

const servers: { close: () => void }[] = [];
const dirs: string[] = [];
let base = "";
let facUrl = "";
const merchantKey = Wallet.createRandom().privateKey;
// each test file draws its ports from its own range (they run in parallel), all below the ephemeral range (49152)
let nextPort = 30000 + Math.floor(Math.random() * 6000);

function startApp(env: Record<string, string> = {}, store?: Store, deps: Partial<AppDeps> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-test-"));
  dirs.push(dir);
  const cfg = loadConfig({
    RPC_URL: "http://127.0.0.1:9",
    PAY_TO: payTo,
    FACILITATOR_URL: facUrl,
    DATA_DIR: dir,
    WIF_ADDRESS: "0x00000000000000000000000000000000000000f1",
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: merchantKey,
    WORKER_TOKEN: "secret",
    ...env,
  });
  const app = createApp({ cfg, chain, store: store ?? new Store(dir), log: () => {}, ...deps });
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  const facPort = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port: facPort }));
  facUrl = `http://127.0.0.1:${facPort}`;
  base = startApp();
});

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  facCalls.length = 0;
  sent.length = 0;
  facValid = true;
  sendFails = false;
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}, at = base) =>
  fetch(`${at}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function terms(route: string, body: unknown, headers: Record<string, string> = {}, at = base) {
  const r = await post(`/api/${route}`, body, headers, at);
  assert.equal(r.status, 402);
  return ((await r.json()) as { accepts: Record<string, any>[] }).accepts[0];
}

async function signed(wallet: BaseWallet, accept: Record<string, any>, amount?: string) {
  const offer = amount ? { ...accept, amount } : accept;
  const typed = typedDataFor(offer, wallet.address);
  const sig = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  return paymentHeader(offer, typed, sig) as string;
}

test("no payment: 402 with USDG on Robinhood Chain Testnet at the standard price", async () => {
  const a = await terms("ask", { question: "help" });
  assert.equal(a.network, "eip155:46630");
  assert.equal(a.asset, "0x7E955252E15c84f5768B83c41a71F9eba181802F");
  assert.equal(a.amount, "100000");
  assert.equal(a.payTo, payTo);
  assert.deepEqual(a.extra, { name: "Global Dollar", version: "1" });
  assert.equal(facCalls.length, 0);
});

test("bad input is refused before the 402 and never reaches the facilitator", async () => {
  for (const body of [{}, { question: "" }, { question: "   " }, { question: 42 }, { question: "x".repeat(501) }, null]) {
    const r = await post("/api/ask", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await post("/api/hire", { question: "wrong field" })).status, 400);
  assert.equal(facCalls.length, 0);
});

test("a malformed X-PAYMENT is a 400, not a 500", async () => {
  const a = await terms("ask", { question: "help" });
  const typed = typedDataFor(a, stranger.address);
  const sig = await stranger.signTypedData(typed.domain, typed.types, typed.message);
  // a well-formed payment whose authorization carries no nonce: it cannot be told apart from a replay
  const noNonce = JSON.parse(Buffer.from(paymentHeader(a, typed, sig), "base64").toString());
  delete noNonce.payload.authorization.nonce;
  facCalls.length = 0;
  const bad = ["not-base64!", Buffer.from("{}").toString("base64"), Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64")];
  for (const h of [...bad, Buffer.from(JSON.stringify(noNonce)).toString("base64")]) {
    const r = await post("/api/ask", { question: "help" }, { "X-PAYMENT": h });
    assert.equal(r.status, 400, h);
  }
  assert.equal(facCalls.length, 0);
});

test("a holder hint quotes the holder price; a stranger's hint does not", async () => {
  assert.equal((await terms("ask", { question: "help" }, { "x-payer": holder.address })).amount, "50000");
  assert.equal((await terms("ask", { question: "help" }, { "x-payer": holder.address.toLowerCase() })).amount, "50000");
  assert.equal((await terms("ask", { question: "help" }, { "x-payer": stranger.address })).amount, "100000");
  assert.equal((await terms("ask", { question: "help" }, { "x-payer": "not-an-address" })).amount, "100000");
  assert.equal((await terms("hire", { request: "x" }, { "x-payer": holder.address })).amount, "250000");
});

test("paid ask: verified, settled, answered, cashback to the signed payer", async () => {
  const a = await terms("ask", { question: "help" });
  const r = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) });
  assert.equal(r.status, 200);
  const body = (await r.json()) as any;
  assert.match(body.answer, /Robinhood Chain Testnet/);
  assert.equal(body.receipt.tier, "standard");
  assert.equal(body.receipt.settleTx, "0x" + "ab".repeat(32));
  assert.deepEqual(facCalls.map((c) => c.path), ["verify", "settle"]);
  assert.deepEqual(sent, [{ to: stranger.address, amount: 10n * 10n ** 18n }]);
});

test("the tier comes from the signer, not from the hint: a stranger cannot pay the holder price", async () => {
  const cheap = await terms("ask", { question: "help" }, { "x-payer": holder.address });
  const r = await post("/api/ask", { question: "help" }, { "x-payer": holder.address, "X-PAYMENT": await signed(stranger, cheap) });
  assert.equal(r.status, 402);
  assert.equal(facCalls.filter((c) => c.path === "settle").length, 0);
  assert.equal(sent.length, 0);
});

test("a holder pays the holder price, or is served at the standard price if that is what they signed", async () => {
  const cheap = await terms("ask", { question: "help" }, { "x-payer": holder.address });
  const r1 = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(holder, cheap) });
  assert.equal(r1.status, 200);
  assert.equal(((await r1.json()) as any).receipt.tier, "holder");
  const full = await terms("ask", { question: "help" });
  const r2 = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(holder, full) });
  assert.equal(r2.status, 200);
  assert.equal(((await r2.json()) as any).receipt.tier, "standard");
  // an amount that is neither price is refused
  const r3 = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(holder, full, "70000") });
  assert.equal(r3.status, 402);
});

test("a facilitator refusal is a 402 and nothing is served or paid back", async () => {
  facValid = false;
  const a = await terms("ask", { question: "help" });
  const r = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) });
  assert.equal(r.status, 402);
  assert.equal(sent.length, 0);
});

test("a failed cashback never fails the paid call, and the ledger says why", async () => {
  sendFails = true;
  const a = await terms("ask", { question: "help" });
  const r = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) });
  assert.equal(r.status, 200);
  const ledger = (await (await fetch(`${base}/api/ledger`)).json()) as any[];
  assert.equal(ledger[0].cashbackTx, null);
  assert.match(ledger[0].cashbackError, /out of \$WIF/);
});

test("hire a human: paid task, claim and complete by the same worker, reward in $WIF", async () => {
  const a = await terms("hire", { request: "photo of the menu" });
  const r = await post("/api/hire", { request: "photo of the menu" }, { "X-PAYMENT": await signed(stranger, a) });
  assert.equal(r.status, 201);
  const { task } = (await r.json()) as any;
  assert.equal(task.status, "open");
  const wh = { "x-worker-token": "secret" };

  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: worker.address })).status, 401);
  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: worker.address }, { "x-worker-token": "Secret" })).status, 401);
  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: "0x123" }, wh)).status, 400);
  assert.equal((await post(`/api/tasks/nope/claim`, { worker: worker.address }, wh)).status, 404);
  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: worker.address.toLowerCase() }, wh)).status, 200);
  // a third wallet (neither the payer nor the claimer) still cannot take a claimed task
  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: Wallet.createRandom().address }, wh)).status, 409);

  sent.length = 0;
  assert.equal((await post(`/api/tasks/${task.id}/complete`, { worker: stranger.address, answer: "done" }, wh)).status, 409);
  assert.equal((await post(`/api/tasks/${task.id}/complete`, { worker: worker.address, answer: "  " }, wh)).status, 400);
  const done = await post(`/api/tasks/${task.id}/complete`, { worker: worker.address, answer: "open until 9pm" }, wh);
  assert.equal(done.status, 200);
  const t = (await done.json()) as any;
  assert.equal(t.status, "done");
  assert.equal(t.rewardTx, "0x" + "cd".repeat(32));
  assert.deepEqual(sent, [{ to: worker.address, amount: 50n * 10n ** 18n }]);
  assert.equal((await post(`/api/tasks/${task.id}/complete`, { worker: worker.address, answer: "again" }, wh)).status, 409);
});

test("info and quote describe the prices without secrets", async () => {
  const info = (await (await fetch(`${base}/api/info`)).json()) as any;
  assert.equal(info.prices.ask.standard, "0.1");
  assert.equal(info.wif.cashback, "10");
  assert.equal(info.network.rpcUrl, "https://rpc.testnet.chain.robinhood.com");
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE|secret/i);
  const everything = JSON.stringify([info, await (await fetch(`${base}/api/ledger`)).json(), await (await fetch(`${base}/api/tasks`)).json()]);
  assert.ok(!everything.toLowerCase().includes(merchantKey.slice(2).toLowerCase()), "the merchant key leaked");
  assert.ok(!everything.includes("secret"), "the worker token leaked");
  const q = (await (await fetch(`${base}/api/quote?payer=${holder.address}`)).json()) as any;
  assert.equal(q.tier, "holder");
  assert.equal((await fetch(`${base}/api/quote?payer=0x12`)).status, 400);
});

test("on a local fork (npm run demo) the page will not ask a browser wallet to sign", async () => {
  const fork = (await (await fetch(`${startApp({}, undefined, { localFork: true })}/api/info`)).json()) as any;
  const live = (await (await fetch(`${base}/api/info`)).json()) as any;
  assert.equal(fork.localFork, true);
  assert.equal(live.localFork, false);
  assert.match(walletPayBlocked(fork), /local fork/);
  assert.equal(walletPayBlocked(live), null);
  // no info, or an older server: closed
  assert.match(walletPayBlocked(undefined), /local fork/);
  assert.match(walletPayBlocked({}), /local fork/);
});

test("a decoy X-PAYMENT next to a real PAYMENT-SIGNATURE is refused, whatever the order", async () => {
  // the attacker's own signature for the holder price, plus a header naming a holder: the SDK pays from
  // PAYMENT-SIGNATURE, so the price must be decided from that one too, or the two must not be mixed at all
  const cheap = await terms("ask", { question: "help" }, { "x-payer": holder.address });
  const real = await signed(stranger, cheap);
  const decoy = await signed(holder, cheap);
  for (const h of [{ "PAYMENT-SIGNATURE": real, "X-PAYMENT": decoy }, { "X-PAYMENT": real, "PAYMENT-SIGNATURE": decoy }]) {
    const r = await post("/api/ask", { question: "help" }, h);
    assert.equal(r.status, 400);
  }
  assert.equal(facCalls.length, 0);
  assert.equal(sent.length, 0);
});

test("PAYMENT-SIGNATURE alone is read like X-PAYMENT, tier included", async () => {
  const cheap = await terms("ask", { question: "help" }, { "x-payer": holder.address });
  const r = await post("/api/ask", { question: "help" }, { "PAYMENT-SIGNATURE": await signed(holder, cheap) });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).receipt.tier, "holder");
  const r2 = await post("/api/ask", { question: "help" }, { "PAYMENT-SIGNATURE": await signed(stranger, cheap) });
  assert.equal(r2.status, 402);
  // the same value in both headers is one payment, not a conflict
  const full = await terms("ask", { question: "help" });
  const h = await signed(stranger, full);
  assert.equal((await post("/api/ask", { question: "help" }, { "PAYMENT-SIGNATURE": h, "X-PAYMENT": h })).status, 200);
});

test("a payment signed for another recipient or another amount is refused by the strict facilitator", async () => {
  const a = await terms("ask", { question: "help" });
  const other = await signed(stranger, { ...a, payTo: worker.address });
  assert.equal((await post("/api/ask", { question: "help" }, { "X-PAYMENT": other })).status, 402);
  assert.equal(sent.length, 0);
});

test("the payer of a task cannot claim it", async () => {
  const a = await terms("hire", { request: "walk my dog" });
  const r = await post("/api/hire", { request: "walk my dog" }, { "X-PAYMENT": await signed(stranger, a) });
  const { task } = (await r.json()) as any;
  const claim = await post(`/api/tasks/${task.id}/claim`, { worker: stranger.address.toLowerCase() }, { "x-worker-token": "secret" });
  assert.equal(claim.status, 409);
});

test("without WORKER_TOKEN, hiring is off before any 402 and the board is closed", async () => {
  const at = startApp({ WORKER_TOKEN: "", WIF_WORKER_REWARD: "0" });
  assert.equal((await post("/api/hire", { request: "x" }, {}, at)).status, 503);
  assert.equal((await post("/api/tasks/any/claim", { worker: worker.address }, {}, at)).status, 401);
  assert.equal((await post("/api/tasks/any/claim", { worker: worker.address }, { "x-worker-token": "" }, at)).status, 401);
  // asking still works
  assert.equal((await post("/api/ask", { question: "help" }, {}, at)).status, 402);
  assert.equal(facCalls.length, 0);
});

test("a call that fails after the settlement still answers with the receipt", async () => {
  class BrokenStore extends Store {
    addLedger(): never {
      throw new Error("EISDIR: rename '/var/folders/xy/flatfee/state.json.123.tmp' at https://rpc.example/v2/KEY123");
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-test-"));
  dirs.push(dir);
  const at = startApp({}, new BrokenStore(dir));
  const a = await terms("ask", { question: "help" }, {}, at);
  const r = await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) }, at);
  assert.equal(r.status, 500);
  const body = (await r.json()) as any;
  assert.equal(body.paid, true);
  assert.equal(body.receipt.settleTx, "0x" + "ab".repeat(32));
  assert.doesNotMatch(JSON.stringify(body), /KEY123|rpc\.example|EISDIR|var\/folders|state\.json/);
});

test("safeMessage drops URLs, so an RPC key never reaches the ledger or a response", () => {
  const ethersLike = Object.assign(new Error('could not coalesce error (info={ "requestUrl": "https://rpc.example/v2/KEY123" })'), {
    shortMessage: "could not coalesce error",
  });
  assert.equal(safeMessage(ethersLike), "could not coalesce error");
  assert.equal(safeMessage(new Error("fetch failed for https://rpc.example/v2/KEY123 and wss://x.y/KEY")), "fetch failed for [url] and [url]");
  assert.equal(safeMessage("plain"), "plain");
  // the configured RPC URL goes in every form it can take inside a message
  const rpc = "https://rpc.example/v2/KEY123";
  for (const m of [`posted to ${rpc}`, `{"url":"https:\\/\\/rpc.example\\/v2\\/KEY123"}`, "host rpc.example/v2/KEY123 refused"]) {
    assert.doesNotMatch(safeMessage(new Error(m), [rpc]), /KEY123/, m);
  }
  assert.ok(safeMessage(new Error("x".repeat(500))).length <= 200);
});

const payAt = async (at: string) => {
  const a = await terms("ask", { question: "help" }, {}, at);
  return post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) }, at);
};
const budgetEnv = (budget: string) => ({ WIF_DAILY_BUDGET: budget, WIF_WORKER_REWARD: "0" });

test("the daily $WIF budget caps cashback to the exact amount, and a send that broadcast nothing gives its share back", async () => {
  // 20 $WIF a day with 10 per call: exactly two cashbacks fit, the third does not
  const at = startApp(budgetEnv("20"));
  sendFails = true;
  assert.equal((await payAt(at)).status, 200); // failed before broadcast: released
  sendFails = false;
  assert.equal((await payAt(at)).status, 200);
  assert.equal((await payAt(at)).status, 200);
  const third = await payAt(at);
  assert.equal(third.status, 200, "the paid call is still served");
  assert.equal(((await third.json()) as any).receipt.cashback.tx, null);
  assert.equal(sent.length, 2);
  const ledger = (await (await fetch(`${at}/api/ledger`)).json()) as any[];
  assert.match(ledger[0].cashbackError, /WIF_DAILY_BUDGET/);
});

test("the $WIF budget starts again on the next UTC day", async () => {
  let clock = new Date("2026-10-30T23:59:00Z");
  const at = startApp(budgetEnv("10"), undefined, { now: () => clock });
  await payAt(at);
  await payAt(at);
  assert.equal(sent.length, 1, "the second cashback of the day went over the budget");
  clock = new Date("2026-10-31T00:01:00Z");
  await payAt(at);
  assert.equal(sent.length, 2, "the budget did not start again on the new day");
});

test("the $WIF budget survives a restart: it lives in state.json, not in the process", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-test-"));
  dirs.push(dir);
  await payAt(startApp(budgetEnv("10"), new Store(dir)));
  assert.equal(sent.length, 1);
  // a new process over the same DATA_DIR
  const again = await payAt(startApp(budgetEnv("10"), new Store(dir)));
  assert.equal(again.status, 200);
  assert.equal(sent.length, 1, "the restart refilled the budget");
});

test("a $WIF transfer that was broadcast but not confirmed keeps its hash and its share of the budget", async () => {
  const at = startApp(budgetEnv("10"));
  const pending = "0x" + "ef".repeat(32);
  const original = chain.sendWif;
  chain.sendWif = async () => {
    throw new WifTransferUnconfirmed(pending, new Error("no receipt after 60000 ms"));
  };
  try {
    const r = await payAt(at);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).receipt.cashback.tx, pending);
  } finally {
    chain.sendWif = original;
  }
  const ledger = (await (await fetch(`${at}/api/ledger`)).json()) as any[];
  assert.equal(ledger[0].cashbackTx, pending);
  assert.match(ledger[0].cashbackError, /not confirmed/);
  // the 10 $WIF may still land, so they stay spent: no second cashback today
  await payAt(at);
  assert.equal(sent.length, 0);
});

test("errors that mention the configured RPC (even without a scheme) are redacted in the ledger", async () => {
  const at = startApp({ RPC_URL: "https://rpc.example/v2/KEY123" });
  const original = chain.sendWif;
  chain.sendWif = async () => {
    throw new Error("request to rpc.example/v2/KEY123 failed, reason: socket hang up");
  };
  try {
    const a = await terms("ask", { question: "help" }, {}, at);
    assert.equal((await post("/api/ask", { question: "help" }, { "X-PAYMENT": await signed(stranger, a) }, at)).status, 200);
    const ledger = (await (await fetch(`${at}/api/ledger`)).json()) as any[];
    assert.match(ledger[0].cashbackError, /\[rpc\]/);
    assert.doesNotMatch(JSON.stringify(ledger), /KEY123/);
  } finally {
    chain.sendWif = original;
  }
});
