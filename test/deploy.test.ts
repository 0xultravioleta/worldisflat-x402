// The deploy's settings with hiring through Execution Market on (deploy/aws/em-hire.env), read the way the container
// reads them: every value parses as .env.example says, the escrow contracts are the ones Execution Market serves for
// Robinhood Chain (its recorded payment-config), each key reaches the container through deploy/aws/main.tf, and
// EM_HIRE=off alone turns it off. Also what PUBLIC_URL does: it names the 402's `resource`, and nothing a payment is
// matched on. No network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain } from "../src/chain.js";
import { CHAINS, loadConfig, type Config, type EmConfig } from "../src/config.js";
import { escrowNetwork, escrowReadiness } from "../src/escrow.js";
import { Store } from "../src/store.js";

type Any = Record<string, any>;
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** KEY=VALUE lines, comments and blank lines skipped; a value is taken as written (no quotes, no expansion) */
function envFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert.ok(m, `not KEY=VALUE: ${line}`);
    assert.ok(!(m[1] in out), `${m[1]} twice`);
    out[m[1]] = m[2];
  }
  return out;
}

const ON = envFile("deploy/aws/em-hire.env");
const RECORDED: Any = JSON.parse(readFileSync("test/fixtures/em-payment-config.json", "utf8"));
// the three secrets the container already holds, stood in for
const SECRETS = { MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey, WORKER_TOKEN: "a-worker-token-of-16+", RPC_URL: "https://private-rpc.example/robinhood/0123456789abcdef" };

test("em-hire.env: no secret in it, and every value reads as .env.example says", () => {
  for (const k of ["MERCHANT_PRIVATE_KEY", "WORKER_TOKEN", "PAYER_PRIVATE_KEY", "RPC_URL"]) assert.ok(!(k in ON), k);
  assert.doesNotMatch(readFileSync("deploy/aws/em-hire.env", "utf8"), /0x[0-9a-fA-F]{64}/);
  const cfg = loadConfig({ ...ON, ...SECRETS });
  assert.equal(cfg.chain.name, "robinhood");
  assert.equal(cfg.payTo, "0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6");
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.publicUrl, "https://flatfee.ultravioletadao.xyz");
  assert.deepEqual([cfg.wif.cashback, cfg.wif.workerReward, cfg.wif.dailyBudget], [10n * 10n ** 18n, 50n * 10n ** 18n, 500n * 10n ** 18n]);
  assert.deepEqual(cfg.em, {
    apiUrl: "https://api.execution.market",
    bounty: 200_000n,
    deadlineHours: 24,
    pollSeconds: 30,
    paymentToken: "USDG",
    escrow: {
      escrow: "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff",
      operator: "0x0258472A1410Ac3Ad720f1BC83f22B3c0af1Fd9D",
      tokenCollector: "0x0E3dF9510de65469C4518D7843919c0b8C7A7757",
    },
    reputationNetwork: null,
  });
  // the bounty fits under the holder price of a hire, so either tier's price covers it
  assert.ok(cfg.em!.bounty <= cfg.prices.hireHolder);
});

test("em-hire.env's escrow is the one Execution Market serves for Robinhood Chain, and the SDK can build it", async () => {
  const cfg = loadConfig({ ...ON, ...SECRETS }) as Config & { em: EmConfig };
  const rh = RECORDED.escrow.networks.robinhood;
  assert.equal(rh.chain_id, 4663);
  assert.equal(rh.tokens.USDG.address, CHAINS.robinhood.usdg);
  // what the merchant would sign against: refused unless EM's contracts are these, any case
  const n = escrowNetwork(cfg, RECORDED);
  assert.deepEqual([n.escrow, n.operator, n.token_collector, n.usdc], [cfg.em.escrow.escrow, cfg.em.escrow.operator, cfg.em.escrow.tokenCollector, CHAINS.robinhood.usdg]);
  // the same check the server runs before every 402: the SDK's own builder, with a throwaway key
  assert.equal(await escrowReadiness(cfg, RECORDED), null);
});

test("every key of em-hire.env reaches the container (deploy/aws/main.tf) and is documented in .env.example", () => {
  const tf = readFileSync("deploy/aws/main.tf", "utf8");
  const block = /environment = \{([\s\S]*?)\n\s*\}/.exec(tf)?.[1] ?? "";
  const container = new Set([...block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
  const example = new Set([...readFileSync(".env.example", "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  for (const k of Object.keys(ON)) {
    assert.ok(container.has(k), `${k} is not in main.tf's container environment`);
    assert.ok(example.has(k), `${k} is not in .env.example`);
  }
  // and every EM_* setting the app reads is in all three
  const read = new Set([...readFileSync("src/config.ts", "utf8").matchAll(/"(EM_[A-Z_]+)"/g)].map((m) => m[1]));
  assert.ok(read.size >= 10);
  for (const k of read) {
    assert.ok(k in ON, `${k} is read by src/config.ts but not set in em-hire.env`);
    assert.ok(container.has(k), `${k} is read by src/config.ts but not in main.tf`);
  }
});

test("the container gets its three secrets from required, sensitive variables (main.tf): RPC_URL too, with no default", () => {
  const tf = readFileSync("deploy/aws/main.tf", "utf8");
  const block = /environment = \{([\s\S]*?)\n\s*\}/.exec(tf)?.[1] ?? "";
  const tfvars = readFileSync("deploy/aws/terraform.tfvars.example", "utf8");
  for (const [k, v] of Object.entries({ RPC_URL: "rpc_url", MERCHANT_PRIVATE_KEY: "merchant_private_key", WORKER_TOKEN: "worker_token" })) {
    assert.match(block, new RegExp(`^\\s*${k}\\s*= var\\.${v}$`, "m"), `main.tf: ${k} = var.${v}`);
    const variable = new RegExp(`variable "${v}" \\{\\n([\\s\\S]*?)\\n\\}`).exec(tf)?.[1] ?? "";
    assert.match(variable, /^\s*sensitive = true$/m, `variable ${v} is sensitive`);
    assert.doesNotMatch(variable, /^\s*default\s*=/m, `variable ${v} has no default`);
    assert.match(tfvars, new RegExp(`^${v}\\s+= ""$`, "m"), `terraform.tfvars.example asks for ${v}, empty`);
  }
  // and an empty rpc_url is refused by terraform itself, before any apply
  assert.match(/variable "rpc_url" \{\n([\s\S]*?)\n\}/.exec(tf)![1], /condition\s+= length\(trimspace\(var\.rpc_url\)\) > 0/);
  // the container refuses to start without it as well (src/config.ts: no default)
  assert.throws(() => loadConfig({ ...ON, ...SECRETS, RPC_URL: "" }), /RPC_URL is required/);
});

test("EM_HIRE=off, and nothing else, turns hiring through Execution Market off: the board takes hires again", async () => {
  for (const off of ["off", "OFF", "false", "0", "no", ""]) {
    const cfg = loadConfig({ ...ON, ...SECRETS, EM_HIRE: off });
    assert.equal(cfg.em, null, off);
  }
  // with the deploy's WORKER_TOKEN, an unpaid hire is quoted on the board again (createApp refuses EM settings without the driver otherwise)
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-deploy-"));
  dirs.push(dir);
  const chain = { provider: {} as JsonRpcProvider, merchantAddress: null, balanceOf: async () => 0n, tierOf: async () => "standard", sendWif: async () => { throw new Error("no"); } } as Chain;
  const cfg = loadConfig({ ...ON, ...SECRETS, EM_HIRE: "off", DATA_DIR: dir, FACILITATOR_URL: "http://127.0.0.1:9" });
  const app = createApp({ cfg, chain, store: new Store(dir), log: () => {} });
  const info = (await (await app.fetch(new Request("http://x/api/info"))).json()) as Any;
  assert.deepEqual(info.hire, { via: "board" });
  const r = await app.fetch(new Request("http://x/api/hire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "x" }) }));
  assert.equal(r.status, 402);
});

test("PUBLIC_URL only names the 402's resource: the same terms whichever host the buyer came in on", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-deploy-"));
  dirs.push(dir);
  const chain = { provider: {} as JsonRpcProvider, merchantAddress: null, balanceOf: async () => 0n, tierOf: async () => "standard", sendWif: async () => { throw new Error("no"); } } as Chain;
  const terms = async (env: Record<string, string>, host: string, route: "ask" | "hire") => {
    const cfg = loadConfig({ ...ON, ...SECRETS, EM_HIRE: "off", DATA_DIR: dir, FACILITATOR_URL: "http://127.0.0.1:9", ...env });
    const app = createApp({ cfg, chain, store: new Store(dir), log: () => {} });
    const body = JSON.stringify(route === "ask" ? { question: "latest block?" } : { request: "a small task" });
    const r = await app.fetch(new Request(`${host}/api/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    assert.equal(r.status, 402);
    return ((await r.json()) as { accepts: Any[] }).accepts[0];
  };
  const lightsail = "https://flatfee.m4qsyfp909142.us-east-2.cs.amazonlightsail.com";
  for (const route of ["ask", "hire"] as const) {
    // with PUBLIC_URL, a buyer on the Lightsail URL and one on the domain see the same resource, the domain's
    const viaDomain = await terms({}, "https://flatfee.ultravioletadao.xyz", route);
    const viaLightsail = await terms({}, lightsail, route);
    assert.equal(viaDomain.resource, `https://flatfee.ultravioletadao.xyz/api/${route}`);
    assert.deepEqual(viaLightsail, viaDomain);
    // and nothing a payment is matched on (network, asset, amount, payTo) depends on it
    const without = await terms({ PUBLIC_URL: "" }, lightsail, route);
    const { resource: a, ...rest } = viaDomain;
    const { resource: b, ...restWithout } = without;
    assert.notEqual(a, b);
    assert.deepEqual(rest, restWithout);
  }
});
