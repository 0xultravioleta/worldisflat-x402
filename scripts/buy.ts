// `npm run buy -- "your question"` (or `-- --hire "a task for a human"`): pays a running Flat Fee server from the
// PAYER_PRIVATE_KEY wallet and prints the answer and the settlement. URL defaults to http://localhost:$PORT.
import { existsSync } from "node:fs";
import { Wallet } from "ethers";
import { loadConfig } from "../src/config.js";
import { buy } from "./lib/buyer.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const hire = args[0] === "--hire";
const text = (hire ? args.slice(1) : args).join(" ").trim() || "What is the latest block and gas on the chain?";
const cfg = loadConfig();
const key = process.env.PAYER_PRIVATE_KEY?.trim();
if (!key) {
  console.error("PAYER_PRIVATE_KEY is not set in .env");
  process.exit(1);
}
const payer = new Wallet(key).address;
const base = process.env.FLATFEE_URL?.replace(/\/+$/, "") ?? `http://localhost:${cfg.port}`;
const route = hire ? "hire" : "ask";

console.log(`${payer} -> ${base}/api/${route} on ${cfg.chain.label}`);
try {
  const r = await buy({
    url: `${base}/api/${route}`,
    body: hire ? { request: text } : { question: text },
    network: cfg.chain.name,
    key,
    payer,
    maxAmount: process.env.MAX_USDG?.trim() || "1.00",
    confirmMainnet: process.env.CONFIRM_MAINNET_SPEND ?? null,
    expectPayTo: process.env.CONFIRM_MAINNET_PAY_TO?.trim() || process.env.PAY_TO?.trim() || null,
  });
  console.log(`paid ${r.price} USDG -> HTTP ${r.status}`);
  console.log(JSON.stringify(r.body, null, 2));
  process.exit(r.status < 300 ? 0 : 1);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
