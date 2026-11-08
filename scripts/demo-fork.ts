// `npm run demo`: the whole product on http://localhost:3000 with no funds and one setting (RPC_URL), on a local anvil fork of
// Robinhood Chain mainnet (real USDG and $WIF bytecode, facilitator double), forked through RPC_URL: a mainnet RPC
// (the team's private one in .env, or your own), never a public default. It pays one question and one hire task
// through the real flow so the ledger and the board have something to show, then stays up until Ctrl-C.
// Transaction links point at the real explorer and will not resolve: these transactions only exist on the fork.
// Only throwaway wallets sign here: the fork keeps chain id 4663, so a signature made on it is a valid mainnet
// authorization for as long as it lives. Never point a real wallet at the demo.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Wallet } from "ethers";
import { X402Client } from "uvd-x402-sdk";
import { createApp } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { CHAINS, loadConfig } from "../src/config.js";
import { createFacilitatorDouble } from "../src/double/facilitator.js";
import { Store } from "../src/store.js";
import { fundFromHolder, setEth, startFork } from "./lib/anvil.js";
import { rpcOrExit } from "./lib/env.js";

const chainInfo = CHAINS.robinhood;
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // holds USDG and $WIF on mainnet; impersonated on the fork only
const port = Number(process.env.PORT ?? 3000);

if (existsSync(".env")) process.loadEnvFile(".env");
const source = rpcOrExit("robinhood", process.env, "npm run demo forks Robinhood Chain mainnet: set RPC_URL to a mainnet RPC (see README, Try it).");
const fork = await startFork(source, chainInfo.chainId, port + 2);
const dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-demo-"));
const merchant = Wallet.createRandom();
const guest = Wallet.createRandom();
await setEth(fork, merchant.address, 10n ** 16n);
await fundFromHolder(fork, chainInfo.wif!, POOL_MANAGER, merchant.address, 1_000n * 10n ** 18n);
await fundFromHolder(fork, chainInfo.usdg, POOL_MANAGER, guest.address, 5_000_000n);

const double = createFacilitatorDouble({ chain: chainInfo, rpcUrl: fork.url, settler: fork.settler });
const facPort = port + 1;
const fac = serve({ fetch: double.app.fetch, port: facPort });

const cfg = loadConfig({
  NETWORK: "robinhood",
  RPC_URL: fork.url,
  FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
  PAY_TO: merchant.address,
  MERCHANT_PRIVATE_KEY: merchant.privateKey,
  WIF_CASHBACK: "10",
  WIF_WORKER_REWARD: "50",
  WIF_HOLDER_MIN: "100",
  WORKER_TOKEN: "demo",
  DATA_DIR: dataDir,
  PORT: String(port),
});
const app = createApp({ cfg, chain: connectChain(cfg), store: new Store(dataDir), localFork: true });
app.use("/*", serveStatic({ root: "./public" }));
const web = serve({ fetch: app.fetch, port });
const base = `http://127.0.0.1:${port}`;

const stop = (code = 0) => {
  web.close();
  fac.close();
  fork.stop();
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

const client = new X402Client({ defaultChain: "robinhood", rpcOverrides: { robinhood: fork.url } });
await client.connectWithPrivateKey(guest.privateKey, "robinhood");
const json = { "content-type": "application/json" };
const ask = await client.fetch(`${base}/api/ask`, { method: "POST", maxAmount: "0.10", init: { headers: json, body: JSON.stringify({ question: "What is the latest block and gas on the chain?" }) } });
const hire = await client.fetch(`${base}/api/hire`, { method: "POST", maxAmount: "0.50", init: { headers: json, body: JSON.stringify({ request: "Check that the cafe on 5th street is open and reply in text with today's hours." }) } });
if (ask.status !== 200 || hire.status !== 201) {
  console.error(`the demo's own payments did not go through: ask ${ask.status} ${(await ask.text()).slice(0, 200)}, hire ${hire.status} ${(await hire.text()).slice(0, 200)}`);
  stop(1);
}

console.log(`
Flat Fee demo on a fork of ${chainInfo.label}: http://localhost:${port}
  fork RPC        ${fork.url} (chain id ${chainInfo.chainId})
  merchant        ${merchant.address} (holds 1000 $WIF for cashback)
  worker token    demo   (paste it in the task board to claim and complete tasks)
  paid so far     1 question and 1 hire task, from a throwaway wallet (see "Paid calls" and "Task board")
  browser wallet  off: the page will not ask a wallet to sign on this fork (a signature here is valid on mainnet)
Ctrl-C to stop.`);
