// `npm run e2e:testnet` / `npm run e2e:mainnet`: one real paid call through the real facilitator, from the
// PAYER_PRIVATE_KEY wallet to PAY_TO, to a server running in this process or, with FLATFEE_URL, to that running server.
// Prints the explorer links.
//
// Mainnet spends real money, and its point is the contest's two transactions (a USDG settlement and a $WIF transfer),
// so with NETWORK=robinhood, PAY_TO, WIF_CASHBACK=10 and MERCHANT_PRIVATE_KEY in .env it refuses to read the chain or
// sign anything unless both approved amounts are given and match exactly (scripts/lib/live.ts):
//   CONFIRM_MAINNET_SPEND=0.10 CONFIRM_MAINNET_WIF=10 npm run e2e:mainnet
// With FLATFEE_URL it pays that running server (the deploy) instead, after checking that its /api/info matches .env;
// that server sends the cashback with its own merchant key, which must be the wallet of MERCHANT_PRIVATE_KEY here.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Wallet, formatEther } from "ethers";
import { createApp } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, txUrl, type NetworkName } from "../src/config.js";
import { Store } from "../src/store.js";
import { buy } from "./lib/buyer.js";
import { configOrExit, keyOrExit } from "./lib/env.js";
import { ledgerCashback, livePassed, liveRunRefusal, remoteRefusal } from "./lib/live.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const network = process.argv[2] as NetworkName;
if (network !== "robinhood" && network !== "robinhood-testnet") throw new Error("usage: e2e-live.ts robinhood|robinhood-testnet");

const env: Record<string, string | undefined> = { ...process.env, NETWORK: network };
// RPC_URL in .env belongs to whichever network .env is for; a live run on the other network uses the public RPC
if (process.env.NETWORK !== network) delete env.RPC_URL;
const cfg = configOrExit(env);
const key = keyOrExit("PAYER_PRIVATE_KEY");
const refusal = liveRunRefusal(cfg, process.env);
if (refusal) {
  console.error(refusal);
  process.exit(1);
}
const remote = process.env.FLATFEE_URL?.trim().replace(/\/+$/, "") || null;
let info: any = null;
if (remote) {
  try {
    info = await (await fetch(`${remote}/api/info`, { signal: AbortSignal.timeout(20_000) })).json();
  } catch (e) {
    console.error(`FLATFEE_URL: cannot read ${remote}/api/info: ${(e as Error).message}`);
    process.exit(1);
  }
  const mismatch = remoteRefusal(cfg, info);
  if (mismatch) {
    console.error(mismatch);
    process.exit(1);
  }
}
const payer = new Wallet(key).address;
const chain = connectChain(cfg);
const dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-live-"));

const fail = (msg: string): never => {
  console.error(msg);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
};

const usdgOf = (a: string) => chain.balanceOf(cfg.chain.usdg, a);
const wifOf = (a: string) => (cfg.wif.token ? chain.balanceOf(cfg.wif.token, a) : Promise.resolve(0n));
const tier = await chain.tierOf(payer);
const price = tier === "holder" ? cfg.prices.askHolder : cfg.prices.ask;
const before = { payer: await usdgOf(payer), payTo: await usdgOf(cfg.payTo), wif: await wifOf(payer) };
console.log(`${cfg.chain.label} (${cfg.chain.caip2}) via ${remote ? String(info.facilitator).slice(0, 120) : cfg.facilitatorUrl}`);
if (remote) console.log(`paying ${remote} (FLATFEE_URL), not a server in this process`);
console.log(`payer ${payer}: ${formatUnits(before.payer, USDG_DECIMALS)} USDG, tier ${tier}, will pay ${formatUnits(price, USDG_DECIMALS)} USDG to ${cfg.payTo}`);

if (before.payer < price) fail(`fund ${payer} with at least ${formatUnits(price, USDG_DECIMALS)} USDG on ${cfg.chain.label} first`);
if (cfg.wif.cashback > 0n) {
  const m = chain.merchantAddress!;
  const [mWif, mEth] = [await wifOf(m), await chain.provider.getBalance(m)];
  console.log(`merchant ${m}: ${formatUnits(mWif, WIF_DECIMALS)} $WIF, ${formatEther(mEth)} ETH; cashback ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF`);
  if (mWif < cfg.wif.cashback || mEth === 0n) fail(`the merchant wallet needs ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF and a little ETH for the cashback`);
}

// a server answers "pending" when the cashback takes longer than it waits (15 s on the deploy): its ledger gets the hash
async function cashbackFromLedger(base: string, settleTx: string) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3_000));
    try {
      const found = ledgerCashback(await (await fetch(`${base}/api/ledger`, { signal: AbortSignal.timeout(10_000) })).json(), settleTx);
      if (found) return found;
    } catch {
      // try again
    }
  }
  return null;
}

const port = 20000 + Math.floor(Math.random() * 20000);
const server = remote ? null : serve({ fetch: createApp({ cfg, chain, store: new Store(dataDir), cashbackWaitMs: 60_000 }).fetch, port });
const base = remote ?? `http://127.0.0.1:${port}`;
let ok = false;
try {
  const r = await buy({
    url: `${base}/api/ask`,
    body: { question: "What is the latest block and gas on the chain?" },
    network,
    key,
    payer,
    maxAmount: formatUnits(price, USDG_DECIMALS),
    confirmMainnet: process.env.CONFIRM_MAINNET_SPEND ?? null,
    expectPayTo: cfg.payTo,
  });
  console.log(`HTTP ${r.status}: ${r.body.answer ?? JSON.stringify(r.body).slice(0, 300)}`);
  const receipt = r.body.receipt ?? {};
  if (receipt.cashback?.tx === "pending" && receipt.settleTx) {
    console.log("cashback pending: reading the server's ledger");
    const c = await cashbackFromLedger(base, receipt.settleTx);
    if (c?.error) console.error(`the server recorded a cashback error: ${c.error.slice(0, 300)}`);
    receipt.cashback.tx = c?.tx ?? null;
    receipt.cashback.url = c?.tx ? txUrl(cfg.chain, c.tx) : null;
  }
  const after = { payer: await usdgOf(payer), payTo: await usdgOf(cfg.payTo), wif: await wifOf(payer) };
  const moved = before.payer - after.payer === price && after.payTo - before.payTo === price;
  console.log(`USDG: payer -${formatUnits(before.payer - after.payer, USDG_DECIMALS)}, pay-to +${formatUnits(after.payTo - before.payTo, USDG_DECIMALS)} ${moved ? "(PASS)" : "(FAIL)"}`);
  if (receipt.settleTx) console.log(`settlement: ${txUrl(cfg.chain, receipt.settleTx)}`);
  if (receipt.cashback?.tx) console.log(`$WIF cashback: ${receipt.cashback.url ?? receipt.cashback.tx} (+${formatUnits(after.wif - before.wif, WIF_DECIMALS)} $WIF)`);
  ok = livePassed({ status: r.status, usdgMoved: moved, cashback: cfg.wif.cashback, cashbackTx: receipt.cashback?.tx, wifGained: after.wif - before.wif });
  if (!ok && moved && cfg.wif.cashback > 0n) console.error(`FAIL  the USDG settled but the ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF cashback did not land (see the ledger error above)`);
} catch (e) {
  console.error((e as Error).message);
} finally {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
