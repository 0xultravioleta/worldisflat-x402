// The app with a fake chain and a fake facilitator: no RPC, no network. Payments are signed locally with the same
// builder the landing page uses (public/x402-browser.js).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet, type BaseWallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain, Tier } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { paymentHeader, typedDataFor } from "../public/x402-browser.js";

const holder = Wallet.createRandom();
const stranger = Wallet.createRandom();
const worker = Wallet.createRandom();
const payTo = Wallet.createRandom().address;

// fake facilitator: valid unless told otherwise, records what it saw
const facCalls: { path: string; value: string; from: string }[] = [];
let facValid = true;
const fac = new Hono();
const seen = (b: any) => b?.paymentPayload?.payload?.authorization ?? {};
fac.post("/verify", async (c) => {
  const a = seen(await c.req.json());
  facCalls.push({ path: "verify", value: a.value, from: a.from });
  return c.json(facValid ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: "insufficient_funds", payer: a.from });
});
fac.post("/settle", async (c) => {
  const a = seen(await c.req.json());
  facCalls.push({ path: "settle", value: a.value, from: a.from });
  return c.json({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:46630", payer: a.from });
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

let servers: { close: () => void }[] = [];
let base = "";
let dataDir = "";

before(async () => {
  const facPort = 30000 + Math.floor(Math.random() * 10000);
  servers.push(serve({ fetch: fac.fetch, port: facPort }));
  dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-test-"));
  const cfg = loadConfig({
    PAY_TO: payTo,
    FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
    DATA_DIR: dataDir,
    WIF_ADDRESS: "0x00000000000000000000000000000000000000f1",
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    WORKER_TOKEN: "secret",
  });
  const app = createApp({ cfg, chain, store: new Store(dataDir), log: () => {} });
  const port = facPort + 1;
  servers.push(serve({ fetch: app.fetch, port }));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  for (const s of servers) s.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  facCalls.length = 0;
  sent.length = 0;
  facValid = true;
  sendFails = false;
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function terms(route: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await post(`/api/${route}`, body, headers);
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
  for (const h of ["not-base64!", Buffer.from("{}").toString("base64"), Buffer.from(JSON.stringify({ x402Version: 2, payload: {} })).toString("base64")]) {
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
  assert.equal((await post(`/api/tasks/${task.id}/claim`, { worker: stranger.address }, wh)).status, 409);

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
  const q = (await (await fetch(`${base}/api/quote?payer=${holder.address}`)).json()) as any;
  assert.equal(q.tier, "holder");
  assert.equal((await fetch(`${base}/api/quote?payer=0x12`)).status, 400);
});
