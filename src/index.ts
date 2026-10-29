// `npm start`: reads .env, serves the landing page and the paid API.
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.js";
import { connectChain } from "./chain.js";
import { ConfigError, USDG_DECIMALS, formatUnits, loadConfig } from "./config.js";
import { Store } from "./store.js";

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
const app = createApp({ cfg, chain, store });
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Flat Fee on ${cfg.chain.label} (${cfg.chain.caip2}) at http://localhost:${info.port}`);
  console.log(`  ask ${formatUnits(cfg.prices.ask, USDG_DECIMALS)} USDG, hire ${formatUnits(cfg.prices.hire, USDG_DECIMALS)} USDG -> ${cfg.payTo}`);
  console.log(`  facilitator ${cfg.facilitatorUrl}`);
});
