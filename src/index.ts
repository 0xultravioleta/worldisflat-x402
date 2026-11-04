// `npm start`: reads .env, serves the landing page and the paid API.
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Wallet } from "ethers";
import { createApp, safeMessage } from "./app.js";
import { connectChain } from "./chain.js";
import { ConfigError, USDG_DECIMALS, formatUnits, loadConfig } from "./config.js";
import { emClient } from "./em.js";
import { createEmHire } from "./emhire.js";
import { escrowPaymentAuth, escrowReadiness } from "./escrow.js";
import { Store } from "./store.js";
import { budgetedWif } from "./wif.js";

if (existsSync(".env")) process.loadEnvFile(".env");

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`config: ${e.message}\nCopy .env.example to .env and fill it in (see README).`);
    process.exit(1);
  }
  throw e;
}

const chain = connectChain(cfg);
const store = new Store(cfg.dataDir);

// EM_HIRE=on: hiring a human goes through Execution Market, signed and paid for by the merchant wallet
let emHire = null;
if (cfg.em) {
  const emCfg = { ...cfg, em: cfg.em };
  const wallet = new Wallet(cfg.merchantKey!);
  emHire = createEmHire({
    cfg: emCfg,
    store,
    api: emClient({ apiUrl: cfg.em.apiUrl, wallet, chainId: cfg.chain.chainId }),
    sendWif: budgetedWif(cfg, chain, store),
    merchant: wallet.address,
    paymentAuth: (paymentConfig, worker, deadlineSec) => escrowPaymentAuth({ cfg: emCfg, wallet }, paymentConfig, worker, deadlineSec),
    ready: (paymentConfig) => escrowReadiness(emCfg, paymentConfig),
    usdgBalance: () => chain.balanceOf(cfg.chain.usdg, wallet.address),
    redact: (e) => safeMessage(e, [cfg.rpcUrl]),
  });
}
const app = createApp({ cfg, chain, store, emHire });
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Flat Fee on ${cfg.chain.label} (${cfg.chain.caip2}) at http://localhost:${info.port}`);
  console.log(`  ask ${formatUnits(cfg.prices.ask, USDG_DECIMALS)} USDG, hire ${formatUnits(cfg.prices.hire, USDG_DECIMALS)} USDG -> ${cfg.payTo}`);
  console.log(`  facilitator ${cfg.facilitatorUrl}`);
  if (cfg.em) console.log(`  hire via Execution Market ${cfg.em.apiUrl}, bounty ${formatUnits(cfg.em.bounty, USDG_DECIMALS)} USDG in escrow`);
  emHire?.start();
});
