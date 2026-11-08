// Every entry point that reads a private key, started for real with a key one digit short: each one must stop with
// exit 1 and must not print the key. They stop before any network call, in an empty directory with no .env.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { startFork } from "../scripts/lib/anvil.js";

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
  // every entry point needs one (no public default); a closed local port, never read before the key is refused
  RPC_URL: "http://127.0.0.1:9",
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

test("no entry point, smoke or probe runs without RPC_URL, or with the RPC of the other network: none falls back to a public RPC", async () => {
  const good = "0x" + "11".repeat(32);
  const none: [string, string[], Record<string, string>][] = [
    ["src/index.ts", [], { NETWORK: "robinhood", PORT: "0" }],
    ["src/index.ts", [], { PORT: "0" }],
    ["scripts/buy.ts", ["hello"], { PAYER_PRIVATE_KEY: good }],
    ["scripts/balances.ts", [], { PAYER_PRIVATE_KEY: good }],
    ["scripts/e2e-live.ts", ["robinhood"], { PAYER_PRIVATE_KEY: good }],
    ["scripts/e2e-live.ts", ["robinhood-testnet"], { PAYER_PRIVATE_KEY: good }],
    ["scripts/verify-testnet.ts", [], {}],
    ["scripts/demo-fork.ts", [], { PORT: "0" }],
    ["scripts/e2e-fork.ts", [], {}],
    ["scripts/e2e-fork.ts", ["robinhood-testnet"], {}],
    ["scripts/e2e-hire.ts", [], { PAYER_PRIVATE_KEY: good, NETWORK: "robinhood" }],
  ];
  const cases = [
    ...none.map(([s, a, e]) => [s, a, { ...e, RPC_URL: "" }, /RPC_URL is required: /] as const),
    // the RPC .env sets for one network is never used to read the other
    ["scripts/e2e-live.ts", ["robinhood"], { PAYER_PRIVATE_KEY: good, NETWORK: "robinhood-testnet" }, /RPC_URL is set for NETWORK=robinhood-testnet, and this run is on robinhood/] as const,
    ["scripts/demo-fork.ts", [], { PORT: "0", NETWORK: "robinhood-testnet" }, /RPC_URL is set for NETWORK=robinhood-testnet, and this run is on robinhood/] as const,
    ["scripts/verify-testnet.ts", [], { NETWORK: "robinhood" }, /RPC_URL is set for NETWORK=robinhood, and this run is on robinhood-testnet/] as const,
  ];
  const results = await Promise.all(cases.map(([script, args, env, want]) => run(script, [...args], env).then((r) => ({ script, env, want, ...r }))));
  for (const { script, env, want, code, out } of results) {
    assert.equal(code, 1, `${script} ${JSON.stringify(env)} exited ${code}: ${out.slice(0, 300)}`);
    assert.match(out, want, `${script} ${JSON.stringify(env)}: ${out.slice(0, 300)}`);
    assert.doesNotMatch(out, /chain\.robinhood\.com/, `${script} named a public RPC: ${out.slice(0, 300)}`);
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

test("a fork that fails never prints its source RPC (RPC_URL, which can carry an API key)", { skip: process.platform === "win32" }, async () => {
  // an `anvil` that says what it was given, the way a real one names the fork URL it could not reach, and exits
  const bin = mkdtempSync(path.join(tmpdir(), "flatfee-anvil-"));
  const fake = path.join(bin, "anvil");
  writeFileSync(fake, '#!/bin/sh\necho "error: failed to fork from $2: unauthorized" >&2\nexit 1\n');
  chmodSync(fake, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    const secret = "https://private-rpc.example/v2/SECRETKEY0123";
    await assert.rejects(startFork(secret, 4663, 1), (e: Error) => {
      assert.match(e.message, /^anvil exited \(1\): error: failed to fork from \[rpc\]: unauthorized/);
      assert.ok(!e.message.includes("SECRETKEY0123") && !e.message.includes("private-rpc.example"), e.message);
      return true;
    });
  } finally {
    process.env.PATH = saved;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a live script reads or pays only once RPC_URL answers its chain's id, and never prints RPC_URL when it fails", async () => {
  // a JSON-RPC stub: /mainnet and /testnet answer that chain's id; /half answers testnet's id, then 401 to the rest;
  // /denied answers 401 to everything, the way a private RPC refuses a bad key
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const u = req.url ?? "";
      const calls = [JSON.parse(body || "null")].flat().filter(Boolean) as { id: number; method: string }[];
      if (u.startsWith("/denied/") || (u.startsWith("/half/") && calls.some((c) => c.method !== "eth_chainId"))) {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      const id = u.startsWith("/mainnet/") ? "0x1237" : "0xb626";
      const out = calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_chainId" ? id : "0x0" }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(JSON.parse(body || "null")) ? out : out[0]));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const good = "0x" + "11".repeat(32);
  // e2e:mainnet with every approval it needs, so the chain is the only thing left to stop it
  const mainnetRun = { PAYER_PRIVATE_KEY: good, WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: "0x" + "22".repeat(32), CONFIRM_MAINNET_SPEND: "0.10", CONFIRM_MAINNET_WIF: "10" };
  const cases: [string, string[], Record<string, string>, RegExp][] = [
    ["scripts/e2e-live.ts", ["robinhood"], { ...mainnetRun, RPC_URL: `${base}/testnet/SECRETKEY0123` }, /RPC_URL answers chain 46630, not Robinhood Chain \(4663\): set the RPC of robinhood/],
    ["scripts/balances.ts", [], { PAYER_PRIVATE_KEY: good, NETWORK: "robinhood", RPC_URL: `${base}/testnet/SECRETKEY0123` }, /RPC_URL answers chain 46630, not Robinhood Chain \(4663\)/],
    ["scripts/balances.ts", [], { PAYER_PRIVATE_KEY: good, RPC_URL: `${base}/denied/SECRETKEY0123` }, /^RPC_URL could not be read: /m],
    ["scripts/balances.ts", [], { PAYER_PRIVATE_KEY: good, RPC_URL: `${base}/half/SECRETKEY0123` }, /^error: /m],
    ["scripts/verify-testnet.ts", [], { RPC_URL: `${base}/denied/SECRETKEY0123` }, /^RPC_URL could not be read: /m],
    ["scripts/verify-testnet.ts", [], { RPC_URL: `${base}/mainnet/SECRETKEY0123` }, /RPC_URL answers chain 4663, not Robinhood Chain Testnet \(46630\)/],
  ];
  try {
    const results = await Promise.all(cases.map(([script, args, env, want]) => run(script, args, env).then((r) => ({ script, env, want, ...r }))));
    for (const { script, env, want, code, out } of results) {
      assert.equal(code, 1, `${script} ${env.RPC_URL} exited ${code}: ${out.slice(0, 300)}`);
      assert.match(out, want, `${script} ${env.RPC_URL}: ${out.slice(0, 300)}`);
      assert.ok(!out.includes("SECRETKEY0123") && !out.includes(base), `${script} printed RPC_URL: ${out.slice(0, 300)}`);
    }
  } finally {
    server.close();
  }
});
