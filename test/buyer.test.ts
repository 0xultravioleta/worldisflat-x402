// The buyer signs only the offer it checked: a server that changes the 402 between the quote and the payment gets
// nothing signed. A stub server, no chain: rpcOverrides point at a closed port, so any RPC use would fail loudly.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Wallet } from "ethers";
import { buy } from "../scripts/lib/buyer.js";

const key = Wallet.createRandom().privateKey;
const merchant = "0x00000000000000000000000000000000000000aa";
const attacker = "0x000000000000000000000000000000000000dEaD";
const USDG_TEST = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const USDG_MAIN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const offer = (o: Record<string, unknown>) => ({ scheme: "exact", maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" }, ...o });
let quotes: Record<string, unknown>[] = [];
let paid: string[] = [];
let n = 0;
const app = new Hono();
app.post("/api/ask", (c) => {
  const p = c.req.header("x-payment") ?? c.req.header("payment-signature");
  if (p) {
    paid.push(p);
    return c.json({ answer: "ok" });
  }
  const q = quotes[Math.min(n++, quotes.length - 1)];
  return c.json({ x402Version: 2, accepts: [q] }, 402);
});
let server: { close: () => void };
let url = "";
before(() => {
  const port = 41000 + Math.floor(Math.random() * 9000);
  server = serve({ fetch: app.fetch, port });
  url = `http://127.0.0.1:${port}/api/ask`;
});
after(() => server.close());

async function run(first: Record<string, unknown>, second: Record<string, unknown>, opts: Partial<Parameters<typeof buy>[0]> = {}) {
  quotes = [first, second];
  paid = [];
  n = 0;
  return buy({ url, body: { question: "q" }, network: "robinhood-testnet", key, maxAmount: "1.00", rpcUrl: "http://127.0.0.1:9", ...opts });
}

const good = offer({ network: "eip155:46630", asset: USDG_TEST, amount: "100000", payTo: merchant });

test("the checked offer is signed and paid", async () => {
  const r = await run(good, good);
  assert.equal(r.status, 200);
  assert.equal(paid.length, 1);
});

test("a second 402 that differs from the checked one gets nothing signed", async () => {
  const swaps: Record<string, unknown>[] = [
    { ...good, payTo: attacker },
    { ...good, amount: "1000000" },
    { ...good, network: "eip155:4663", asset: USDG_MAIN },
    { ...good, asset: "0x0000000000000000000000000000000000000001" },
    { ...good, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ];
  for (const second of swaps) {
    await assert.rejects(run(good, second), /no payment option|NO_ACCEPTABLE|refus/i, JSON.stringify(second));
    assert.equal(paid.length, 0, `signed ${JSON.stringify(second)}`);
  }
});

test("a first 402 that is not USDG on this network is refused before signing", async () => {
  await assert.rejects(run({ ...good, network: "eip155:4663", asset: USDG_MAIN }, good), /not USDG/);
  await assert.rejects(run({ ...good, asset: "0x0000000000000000000000000000000000000001" }, good), /not USDG/);
  assert.equal(paid.length, 0);
});

test("the expected pay-to is enforced", async () => {
  await assert.rejects(run({ ...good, payTo: attacker }, { ...good, payTo: attacker }, { expectPayTo: merchant }), /expected/);
  assert.equal(paid.length, 0);
});

test("mainnet needs the exact confirmed amount and the expected pay-to", async () => {
  const main = offer({ network: "eip155:4663", asset: USDG_MAIN, amount: "100000", payTo: merchant });
  const m = { network: "robinhood" as const };
  await assert.rejects(run(main, main, { ...m, expectPayTo: merchant }), /CONFIRM_MAINNET_SPEND/);
  await assert.rejects(run(main, main, { ...m, expectPayTo: merchant, confirmMainnet: "0.11" }), /CONFIRM_MAINNET_SPEND/);
  await assert.rejects(run(main, main, { ...m, confirmMainnet: "0.10" }), /pay-to/);
  assert.equal(paid.length, 0);
  // approved: exactly 0.10 to the merchant, and the second 402 may not raise it
  await assert.rejects(run(main, { ...main, amount: "200000" }, { ...m, expectPayTo: merchant, confirmMainnet: "0.10" }));
  assert.equal(paid.length, 0);
  const ok = await run(main, main, { ...m, expectPayTo: merchant, confirmMainnet: "0.10" });
  assert.equal(ok.status, 200);
  assert.equal(paid.length, 1);
});
