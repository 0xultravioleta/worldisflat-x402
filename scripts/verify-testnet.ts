// `npm run verify:testnet`: the production path against the REAL facilitator on Robinhood Chain Testnet, read-only.
// Three checks, every read through RPC_URL (a testnet RPC: there is no public default):
//   1. the EIP-712 domain the app signs with hashes to USDG's own on-chain DOMAIN_SEPARATOR() on testnet (mainnet's is
//      proven by the fork run, where USDG's transferWithAuthorization accepts the signature, and by the mainnet runs);
//   2. the app's paywall forwards a signed USDG authorization to the facilitator's /verify. The payer is a fresh
//      throwaway wallet with no funds, so it must come back `insufficient_funds`: the facilitator parsed the v2
//      envelope, accepted the network, the USDG asset, the amount and the recipient, and got as far as the balance check;
//   3. control: an expired authorization must come back `invalid_timing`, so the refusal above is not a blanket one.
// The facilitator checks the balance before the signature, so the signature itself is proven by (1) and by the fork
// run (`npm run e2e:fork`), where USDG's transferWithAuthorization accepts it. The payer never holds anything and no
// key from .env is used, so nothing can be settled or broadcast.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Contract, JsonRpcProvider, TypedDataEncoder, Wallet } from "ethers";
import { X402Client } from "uvd-x402-sdk";
import { createApp } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { CHAINS, USDG_DECIMALS, USDG_DOMAIN, formatUnits, loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { chainIdOrExit, exitRedacted, rpcOrExit } from "./lib/env.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const chainInfo = CHAINS["robinhood-testnet"];
const rpc = rpcOrExit("robinhood-testnet", process.env, "npm run verify:testnet reads Robinhood Chain Testnet: run it with NETWORK=robinhood-testnet and a testnet RPC_URL.");
exitRedacted([rpc]);
await chainIdOrExit(rpc, chainInfo);
const payer = Wallet.createRandom();
const key = payer.privateKey;
const payTo = process.env.PAY_TO?.trim() || Wallet.createRandom().address;

const dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-verify-"));
const cfg = loadConfig({ NETWORK: "robinhood-testnet", RPC_URL: rpc, PAY_TO: payTo, DATA_DIR: dataDir, FACILITATOR_URL: process.env.FACILITATOR_URL });
const chain = connectChain(cfg);
const usdg = await chain.balanceOf(chainInfo.usdg, payer.address);
const app = createApp({ cfg, chain, store: new Store(dataDir), log: () => {} });
const port = 20000 + Math.floor(Math.random() * 20000);
const server = serve({ fetch: app.fetch, port });
const url = `http://127.0.0.1:${port}/api/ask`;
const init = { headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "latest block?" }) };

console.log(`facilitator ${cfg.facilitatorUrl}, network ${chainInfo.caip2}`);
console.log(`throwaway payer ${payer.address} holds ${formatUnits(usdg, USDG_DECIMALS)} testnet USDG; pay to ${payTo}`);

let failed = false;
try {
  for (const c of [chainInfo]) {
    const ours = TypedDataEncoder.hashDomain({ ...USDG_DOMAIN, chainId: c.chainId, verifyingContract: c.usdg });
    const token = new Contract(c.usdg, ["function DOMAIN_SEPARATOR() view returns (bytes32)"], new JsonRpcProvider(rpc, c.chainId, { staticNetwork: true }));
    const onchain = (await token.DOMAIN_SEPARATOR()) as string;
    const ok = ours.toLowerCase() === onchain.toLowerCase();
    console.log(`${ok ? "PASS" : "FAIL"}  USDG EIP-712 domain on ${c.caip2}: ours ${ours}, on chain ${onchain}`);
    failed ||= !ok;
  }

  const client = new X402Client({ defaultChain: "robinhood-testnet", rpcOverrides: { "robinhood-testnet": rpc } });
  await client.connectWithPrivateKey(key, "robinhood-testnet");
  const r = await client.fetch(url, { method: "POST", maxAmount: "0.10", init });
  const body = await r.text();
  console.log(`\nsigned payment -> ${r.status} ${body.slice(0, 300)}`);
  {
    const ok = usdg === 0n && r.status === 402 && /insufficient_funds/.test(body);
    console.log(ok ? "PASS  the facilitator took the payment as far as the balance check (insufficient_funds)" : "FAIL  expected insufficient_funds");
    failed ||= !ok;
  }

  const q = await fetch(url, { method: "POST", ...init });
  const terms = (await q.json()) as { accepts: Record<string, unknown>[] };
  const browser = await import("../public/x402-browser.js" as string);
  const typed = browser.typedDataFor(terms.accepts[0], payer.address, { now: Math.floor(Date.now() / 1000) - 3600 });
  const sig = await payer.signTypedData(typed.domain, typed.types, typed.message);
  const rc = await fetch(url, { method: "POST", ...init, headers: { ...init.headers, "X-PAYMENT": browser.paymentHeader(terms.accepts[0], typed, sig) } });
  const cbody = await rc.text();
  console.log(`\nexpired authorization -> ${rc.status} ${cbody.slice(0, 300)}`);
  const ok = rc.status === 402 && /invalid_timing/.test(cbody);
  console.log(ok ? "PASS  control refused for timing, not for funds" : "FAIL  the control did not come back invalid_timing");
  failed ||= !ok;
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
