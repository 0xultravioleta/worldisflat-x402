// Every entry point that reads a private key, started for real with a key one digit short: each one must stop with
// exit 1 and must not print the key. They stop before any network call, in an empty directory with no .env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = import.meta.resolve("tsx");
const cwd = mkdtempSync(path.join(tmpdir(), "flatfee-keys-"));
after(() => rmSync(cwd, { recursive: true, force: true }));

const BAD = "0x" + "de".repeat(31) + "f";
const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: cwd,
  // closed network: the proxy at port 9 refuses, so nothing here could reach a real RPC even by mistake
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  NODE_USE_ENV_PROXY: "1",
  NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
  PAY_TO: "0x000000000000000000000000000000000000dEaD",
};

function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsx, path.join(root, script), ...args], { cwd, env: { ...BASE_ENV, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} still running after 30 s: ${out.slice(0, 300)}`));
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const cases: [string, string[], Record<string, string>][] = [
  ["src/index.ts", [], { NETWORK: "robinhood", WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: BAD, PORT: "0" }],
  ["scripts/buy.ts", ["hello"], { PAYER_PRIVATE_KEY: BAD }],
  ["scripts/buy.ts", ["hello"], { MERCHANT_PRIVATE_KEY: BAD, PAYER_PRIVATE_KEY: "0x" + "11".repeat(32) }],
  ["scripts/balances.ts", [], { PAYER_PRIVATE_KEY: BAD }],
  ["scripts/balances.ts", [], { MERCHANT_PRIVATE_KEY: BAD }],
  ["scripts/e2e-live.ts", ["robinhood-testnet"], { PAYER_PRIVATE_KEY: BAD }],
  ["scripts/e2e-live.ts", ["robinhood"], { WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: BAD, PAYER_PRIVATE_KEY: "0x" + "11".repeat(32) }],
];

test("no entry point prints a malformed private key", async () => {
  const results = await Promise.all(cases.map(([script, args, env]) => run(script, args, env).then((r) => ({ script, env, ...r }))));
  for (const { script, env, code, out } of results) {
    const name = Object.keys(env).find((k) => env[k] === BAD);
    assert.equal(code, 1, `${script} (${name}) exited ${code}: ${out.slice(0, 300)}`);
    assert.ok(!out.toLowerCase().includes(BAD.slice(2, 22)), `${script} printed ${name}: ${out.slice(0, 300)}`);
    assert.match(out, new RegExp(`${name}.*not shown`), `${script} did not name ${name}: ${out.slice(0, 300)}`);
  }
});

test("e2e:mainnet stops before the chain when CONFIRM_MAINNET_WIF is given but WIF_CASHBACK is 0", async () => {
  const r = await run("scripts/e2e-live.ts", ["robinhood"], {
    PAYER_PRIVATE_KEY: "0x" + "11".repeat(32),
    CONFIRM_MAINNET_SPEND: "0.10",
    CONFIRM_MAINNET_WIF: "10",
  });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /WIF_CASHBACK=10 and MERCHANT_PRIVATE_KEY/);
});

test("e2e:mainnet with FLATFEE_URL stops before the chain when that server's /api/info does not match .env", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ localFork: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await run("scripts/e2e-live.ts", ["robinhood"], {
      PAYER_PRIVATE_KEY: "0x" + "11".repeat(32),
      WIF_CASHBACK: "10",
      MERCHANT_PRIVATE_KEY: "0x" + "22".repeat(32),
      CONFIRM_MAINNET_SPEND: "0.10",
      CONFIRM_MAINNET_WIF: "10",
      FLATFEE_URL: `${base}/`,
      // the chain is read through the same server, so a run that went on past the refusal would show up in `seen`
      NETWORK: "robinhood",
      RPC_URL: `${base}/rpc`,
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FLATFEE_URL: .*localFork: false.*refusing/);
    assert.deepEqual(seen, ["GET /api/info"]);
  } finally {
    server.close();
  }
});
