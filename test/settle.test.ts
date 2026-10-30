// Charge before serving, and serve one payment once: the paid routes against a facilitator that verifies anything well
// formed and spends each nonce once, like the real one. No RPC, no network. Started from the RWIF1 refuter's repro.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createPurchaseContext, purchaseContextHeader } from "uvd-x402-sdk";
import { createHonoMiddleware } from "uvd-x402-sdk/backend";
import { createApp, type AppDeps } from "../src/app.js";
import type { Chain, Tier } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { paymentHeader, typedDataFor } from "../public/x402-browser.js";

const payer = Wallet.createRandom();
const payTo = Wallet.createRandom().address;
const TX = "0x" + "ab".repeat(32);

// "spend-once": settle succeeds the first time a nonce is seen and refuses it after that.
// "refuse": settle refuses everything. "resend": a nonce already spent comes back as the original success, marked
// replayed, as the facilitator answers a resend bound with the same X-UVD-Purchase.
let settleMode: "spend-once" | "refuse" | "resend" = "spend-once";
const spent = new Set<string>();
const calls: string[] = [];
const fac = new Hono();
fac.post("/verify", async (c) => {
  const b = await c.req.json();
  calls.push("verify");
  await new Promise((r) => setTimeout(r, 30));
  return c.json({ isValid: true, payer: b.paymentPayload.payload.authorization.from });
});
fac.post("/settle", async (c) => {
  const b = await c.req.json();
  calls.push("settle");
  const { nonce, from } = b.paymentPayload.payload.authorization;
  const ok = { success: true, transaction: TX, network: "eip155:46630", payer: from };
  if (settleMode === "refuse") return c.json({ success: false, errorReason: "insufficient_funds", network: "eip155:46630" });
  if (spent.has(nonce)) {
    return settleMode === "resend" ? c.json({ ...ok, replayed: true }) : c.json({ success: false, errorReason: "authorization_already_used", network: "eip155:46630" });
  }
  spent.add(nonce);
  return c.json(ok);
});

const sent: { to: string; amount: bigint }[] = [];
const chain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: null,
  balanceOf: async () => 0n,
  tierOf: async (): Promise<Tier> => "standard",
  sendWif: async (to: string, amount: bigint) => {
    sent.push({ to, amount });
    return { to, amount, tx: "0x" + "cd".repeat(32) };
  },
};

const servers: { close: () => void }[] = [];
const dirs: string[] = [];
const logs: string[] = [];
let facUrl = "";
let base = "";
let nextPort = 40000 + Math.floor(Math.random() * 10000);

function startApp(deps: Partial<AppDeps> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-settle-"));
  dirs.push(dir);
  const cfg = loadConfig({
    PAY_TO: payTo,
    FACILITATOR_URL: facUrl,
    DATA_DIR: dir,
    WIF_ADDRESS: "0x00000000000000000000000000000000000000f1",
    WIF_CASHBACK: "10",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
  });
  const app = createApp({ cfg, chain, store: new Store(dir), log: (m) => logs.push(m), ...deps });
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  return `http://127.0.0.1:${port}`;
}

before(() => {
  const port = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port }));
  facUrl = `http://127.0.0.1:${port}`;
  base = startApp();
});
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  settleMode = "spend-once";
  sent.length = 0;
  calls.length = 0;
  logs.length = 0;
});

const post = (body: unknown, headers: Record<string, string> = {}, at = base) =>
  fetch(`${at}/api/ask`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function header(at = base) {
  const accept = ((await (await post({ question: "help" }, {}, at)).json()) as { accepts: Record<string, unknown>[] }).accepts[0];
  const typed = typedDataFor(accept, payer.address);
  const sig = await payer.signTypedData(typed.domain, typed.types, typed.message);
  return paymentHeader(accept, typed, sig) as string;
}

const ledger = async (at = base) => (await (await fetch(`${at}/api/ledger`)).json()) as { authorization?: string }[];

// The SDK's own refusal of a failed settle, given before our handler runs: a 500 "Payment settlement failed". The
// handler's fallback for an unsettled payment is a 502, so seeing the 500 proves the paywall settled first.
async function refusedByPaywall(r: Response) {
  assert.equal(r.status, 500, "the paywall, not the handler, refuses an unsettled payment");
  assert.equal(((await r.json()) as { error?: string }).error, "Payment settlement failed");
}

test("REF-A: verify passes but the settle is refused: the paywall answers, nothing is served, logged or paid back", async () => {
  const before = (await ledger()).length;
  settleMode = "refuse";
  const r = await post({ question: "help" }, { "X-PAYMENT": await header() });
  await refusedByPaywall(r);
  assert.deepEqual(calls, ["verify", "settle"]);
  assert.equal(sent.length, 0, "cashback paid without a settlement");
  assert.equal((await ledger()).length, before);
  assert.ok(!logs.some((l) => l.includes("unsettled payment")), "the handler ran for an unsettled payment");
});

test("REF-B: three copies of one payment at once: served once, one cashback, the others refused by the paywall", async () => {
  const before = (await ledger()).length;
  const h = await header();
  const rs = await Promise.all([0, 1, 2].map(() => post({ question: "help" }, { "X-PAYMENT": h })));
  assert.equal(rs.filter((r) => r.status === 200).length, 1, `statuses ${rs.map((r) => r.status)}`);
  for (const r of rs.filter((x) => x.status !== 200)) await refusedByPaywall(r);
  assert.equal(sent.length, 1, `cashbacks ${sent.length}`);
  assert.equal((await ledger()).length, before + 1);
});

test("REF-C: a payment sent again later is refused by the paywall; one cashback", async () => {
  const h = await header();
  assert.equal((await post({ question: "help" }, { "X-PAYMENT": h })).status, 200);
  await refusedByPaywall(await post({ question: "help" }, { "X-PAYMENT": h }));
  assert.equal(sent.length, 1);
});

async function purchase(body: string) {
  const ctx = createPurchaseContext() as unknown as Record<string, string>;
  ctx.method = "POST";
  ctx.url = new URL(`${base}/api/ask`).toString();
  ctx.bodySha256 = createHash("sha256").update(body).digest("hex");
  return purchaseContextHeader(ctx as never);
}

test("REF-D: a POST bound with X-UVD-Purchase (the SDK's fetchWithReceipt) is paid and served", async () => {
  const body = JSON.stringify({ question: "help" });
  const h = await header();
  calls.length = 0;
  const r = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": h, "X-UVD-Purchase": await purchase(body) }, body });
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(calls, ["verify", "settle"]);
  assert.equal(sent.length, 1);
});

test("one authorization is served once, even when the facilitator answers a bound resend with the original success", async () => {
  settleMode = "resend";
  const before = (await ledger()).length;
  const body = JSON.stringify({ question: "help" });
  const h = await header();
  const ctx = await purchase(body);
  const send = () => fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": h, "X-UVD-Purchase": ctx }, body });
  assert.equal((await send()).status, 200);
  const again = await send();
  assert.equal(again.status, 409);
  const b = (await again.json()) as { paid?: boolean; settleTx?: string };
  assert.equal(b.paid, true);
  assert.equal(b.settleTx, TX);
  assert.equal(sent.length, 1, "a resend paid the cashback again");
  assert.equal((await ledger()).length, before + 1);
});

test("if the SDK ever let an unsettled payment reach the handler, nothing is served and no $WIF goes out", async () => {
  // an SDK that serves before settling (settlementStrategy "manual"): the handler's own settle is all that is left
  const at = startApp({ middleware: (o) => createHonoMiddleware({ ...o, settlementStrategy: "manual" }) });
  settleMode = "refuse";
  const r = await post({ question: "help" }, { "X-PAYMENT": await header(at) }, at);
  assert.equal(r.status, 502);
  assert.equal(sent.length, 0);
  assert.equal((await ledger(at)).length, 0);
  // and when that settle succeeds, the call is served once
  settleMode = "spend-once";
  const ok = await post({ question: "help" }, { "X-PAYMENT": await header(at) }, at);
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
});
