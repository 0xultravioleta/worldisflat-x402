// `npm run em:register`: gives the merchant wallet the ERC-8004 identity on Base that Execution Market requires of
// every publisher, once, before EM_HIRE goes on (docs/EXECUTION-MARKET.md). Gasless: EM's facilitator mints it. A dry run
// unless CONFIRM_EM_REGISTER is the merchant's address; it reads EM's public status first and never registers a wallet
// that already has an identity or one in flight (scripts/lib/register.ts).
//   MERCHANT_PRIVATE_KEY=... npm run em:register                       (dry run: says what it would send)
//   MERCHANT_PRIVATE_KEY=... CONFIRM_EM_REGISTER=0x<merchant> npm run em:register
// Optional: EM_API_URL (https://api.execution.market), EM_AGENT_URI (https://flatfee.ultravioletadao.xyz).
import { existsSync } from "node:fs";
import { Wallet } from "ethers";
import { CHAINS } from "../src/config.js";
import { emCaller } from "./lib/emworker.js";
import { keyOrExit } from "./lib/env.js";
import { origin } from "./lib/hire.js";
import { registerPlanRefusal, runRegister } from "./lib/register.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const wallet = new Wallet(keyOrExit("MERCHANT_PRIVATE_KEY"));
const apiUrl = origin(process.env.EM_API_URL?.trim() || "https://api.execution.market");
if (!apiUrl) {
  console.error("EM_API_URL must be Execution Market's API origin, https");
  process.exit(1);
}
const agentUri = process.env.EM_AGENT_URI?.trim() || "https://flatfee.ultravioletadao.xyz";
const refusal = registerPlanRefusal({ merchant: wallet.address, agentUri });
if (refusal) {
  console.error(refusal);
  process.exit(1);
}

// the merchant signs as Flat Fee does on Execution Market: ERC-8128, keyid on Robinhood Chain (EM looks identities up on Base whatever the keyid's chain)
const { call, send } = emCaller({ apiUrl, auth: { kind: "erc8128", wallet, chainId: CHAINS.robinhood.chainId, client: null } });
const outcome = await runRegister(
  { merchant: wallet.address, agentUri, confirm: process.env.CONFIRM_EM_REGISTER?.trim() || null, pollMs: 5_000, timeoutMs: 10 * 60_000 },
  {
    get: (p) => send(`${apiUrl}${p}`, { method: "GET", headers: { accept: "application/json" } }),
    register: (body) => call("POST", "/api/v1/reputation/register", body),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => console.log(l),
  },
);
if (outcome.transaction && /^0x[0-9a-fA-F]{64}$/.test(outcome.transaction)) console.log(`transaction: https://basescan.org/tx/${outcome.transaction}`);
process.exit(outcome.ok ? 0 : 1);
