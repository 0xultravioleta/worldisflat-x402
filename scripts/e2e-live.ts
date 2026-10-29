// `npm run e2e:testnet` / `npm run e2e:mainnet`: one real paid call through the real facilitator, from the
// PAYER_PRIVATE_KEY wallet to PAY_TO, with the server running in this process. Prints the explorer links.
//
// Mainnet spends real money, so it refuses to sign unless the exact amounts were approved:
//   CONFIRM_MAINNET_SPEND=0.10 npm run e2e:mainnet                        # cashback off
//   CONFIRM_MAINNET_SPEND=0.10 CONFIRM_MAINNET_WIF=10 npm run e2e:mainnet  # with WIF_CASHBACK=10 in .env
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Wallet, formatEther } from "ethers";
import { createApp } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, loadConfig, txUrl, type NetworkName } from "../src/config.js";
import { Store } from "../src/store.js";
import { buy, confirms } from "./lib/buyer.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const network = process.argv[2] as NetworkName;
if (network !== "robinhood" && network !== "robinhood-testnet") throw new Error("usage: e2e-live.ts robinhood|robinhood-testnet");
const mainnet = network === "robinhood";

const dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-live-"));
const env: Record<string, string | undefined> = { ...process.env, NETWORK: network, DATA_DIR: dataDir };
// RPC_URL in .env belongs to whichever network .env is for; a live run on the other network uses the public RPC
if (process.env.NETWORK !== network) delete env.RPC_URL;
const cfg = loadConfig(env);
const key = process.env.PAYER_PRIVATE_KEY?.trim();
if (!key) throw new Error("PAYER_PRIVATE_KEY is not set in .env");
const payer = new Wallet(key).address;
const chain = connectChain(cfg);

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
console.log(`${cfg.chain.label} (${cfg.chain.caip2}) via ${cfg.facilitatorUrl}`);
console.log(`payer ${payer}: ${formatUnits(before.payer, USDG_DECIMALS)} USDG, tier ${tier}, will pay ${formatUnits(price, USDG_DECIMALS)} USDG to ${cfg.payTo}`);

if (before.payer < price) fail(`fund ${payer} with at least ${formatUnits(price, USDG_DECIMALS)} USDG on ${cfg.chain.label} first`);
if (cfg.wif.cashback > 0n) {
  const m = chain.merchantAddress!;
  const [mWif, mEth] = [await wifOf(m), await chain.provider.getBalance(m)];
  console.log(`merchant ${m}: ${formatUnits(mWif, WIF_DECIMALS)} $WIF, ${formatEther(mEth)} ETH; cashback ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF`);
  if (mWif < cfg.wif.cashback || mEth === 0n) fail(`the merchant wallet needs ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF and a little ETH for the cashback`);
  if (mainnet && !confirms(process.env.CONFIRM_MAINNET_WIF, cfg.wif.cashback, WIF_DECIMALS)) {
    fail(`mainnet: this run sends ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF cashback. Re-run with CONFIRM_MAINNET_WIF=${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} once approved.`);
  }
}

const app = createApp({ cfg, chain, store: new Store(dataDir), cashbackWaitMs: 60_000 });
const port = 20000 + Math.floor(Math.random() * 20000);
const server = serve({ fetch: app.fetch, port });
let ok = false;
try {
  const r = await buy({
    url: `http://127.0.0.1:${port}/api/ask`,
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
  const after = { payer: await usdgOf(payer), payTo: await usdgOf(cfg.payTo), wif: await wifOf(payer) };
  const moved = before.payer - after.payer === price && after.payTo - before.payTo === price;
  console.log(`USDG: payer -${formatUnits(before.payer - after.payer, USDG_DECIMALS)}, pay-to +${formatUnits(after.payTo - before.payTo, USDG_DECIMALS)} ${moved ? "(PASS)" : "(FAIL)"}`);
  if (receipt.settleTx) console.log(`settlement: ${txUrl(cfg.chain, receipt.settleTx)}`);
  if (receipt.cashback?.tx) console.log(`$WIF cashback: ${receipt.cashback.url ?? receipt.cashback.tx} (+${formatUnits(after.wif - before.wif, WIF_DECIMALS)} $WIF)`);
  ok = r.status === 200 && moved;
} catch (e) {
  console.error((e as Error).message);
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
