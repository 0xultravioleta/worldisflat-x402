import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pickSkill } from "../src/agent.js";
import { CHAINS, ConfigError, formatUnits, loadConfig, parseUnitsStrict, privateKey, rpcUrlFor } from "../src/config.js";
import { confirms } from "../scripts/lib/buyer.js";

const PAY_TO = "0x00000000000000000000000000000000000000aa";
/** a stand-in for the RPC every config needs: a closed local port (no test reads the chain through it) */
const RPC_URL = "http://127.0.0.1:9";

test("RPC_URL is required on mainnet and testnet: no default, and never the chain's public RPC", () => {
  for (const NETWORK of [undefined, "robinhood", "robinhood-testnet", " Robinhood "]) {
    for (const rpc of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { PAY_TO, NETWORK, RPC_URL: rpc };
      assert.throws(() => loadConfig(env), (e: unknown) => e instanceof ConfigError && /^RPC_URL is required: /.test((e as Error).message), JSON.stringify(env));
    }
  }
  // given, it is the one used, as written, on either network
  for (const NETWORK of ["robinhood", "robinhood-testnet"] as const) {
    const c = loadConfig({ PAY_TO, NETWORK, RPC_URL: " https://private-rpc.example/v2/KEY " });
    assert.equal(c.rpcUrl, "https://private-rpc.example/v2/KEY");
    assert.notEqual(c.rpcUrl, CHAINS[NETWORK].publicRpcUrl);
  }
  // the message never shows a value: there is none, and it names what to set
  assert.throws(() => loadConfig({ PAY_TO, NETWORK: "robinhood" }), /RPC_URL is required: the Robinhood Chain RPC to use \(there is no default, and no public RPC is used\)/);
});

test("rpcUrlFor: a run on one network never reads it through the RPC set for the other", () => {
  assert.equal(rpcUrlFor({ RPC_URL: "https://a.example" }, "robinhood"), "https://a.example");
  assert.equal(rpcUrlFor({ RPC_URL: "https://a.example", NETWORK: " ROBINHOOD " }, "robinhood"), "https://a.example");
  assert.throws(() => rpcUrlFor({ RPC_URL: "https://a.example", NETWORK: "robinhood" }, "robinhood-testnet"), /RPC_URL is set for NETWORK=robinhood, and this run is on robinhood-testnet/);
  assert.throws(() => rpcUrlFor({ RPC_URL: "https://a.example", NETWORK: "robinhood-testnet" }, "robinhood"), (e: unknown) => e instanceof ConfigError && !(e as Error).message.includes("a.example"));
  assert.throws(() => rpcUrlFor({ NETWORK: "robinhood" }, "robinhood"), /RPC_URL is required/);
});

test("the chains' public RPCs are only a fact for the wallet's add network: no code connects through them", () => {
  // every source file of the server and the scripts
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(ts|js)$/.test(e.name)) files.push(f.split(path.sep).join("/"));
    }
  };
  for (const d of ["src", "scripts", "public"]) walk(d);
  assert.ok(files.length > 20 && files.includes("src/config.ts"), "the sources");
  // the field is read in two places: GET /api/info (the add network) and the hire run's refusal of a public RPC
  const reads = new Map<string, string[]>();
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n").filter((l) => /\.publicRpcUrl\b/.test(l));
    if (lines.length) reads.set(f, lines);
  }
  assert.deepEqual([...reads.keys()].sort(), ["scripts/lib/hire.ts", "src/app.ts"], "who reads publicRpcUrl");
  assert.equal(reads.get("src/app.ts")!.length, 1);
  assert.match(reads.get("src/app.ts")![0], /^\s*network: \{ .*rpcUrl: cfg\.chain\.publicRpcUrl \},$/, "src/app.ts: only /api/info's network");
  assert.equal(reads.get("scripts/lib/hire.ts")!.length, 1);
  assert.match(reads.get("scripts/lib/hire.ts")![0], /^\s*const publics = \[CHAINS\.robinhood\.publicRpcUrl, CHAINS\["robinhood-testnet"\]\.publicRpcUrl\]/, "scripts/lib/hire.ts: the refusal list");
  // the SDK's X402Client ships the public RPCs as its defaults: every one the code makes is given the RPC to use
  const clients = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => l.includes("new X402Client(")).map((l) => [f, l] as const));
  assert.ok(clients.length >= 4, "the X402Clients");
  for (const [f, l] of clients) assert.match(l, /new X402Client\(\{ defaultChain: [^,]+, rpcOverrides: \{ /, `${f}: an X402Client without rpcOverrides: ${l.trim()}`);
  // every script that reads RPC_URL (rpcOrExit, configOrExit) prints an error nobody caught without it (exitRedacted),
  // and buy.ts's own catch does too
  const readers = files.filter((f) => /^scripts\/[^/]+\.ts$/.test(f) && /\b(?:rpcOrExit|configOrExit)\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(readers.sort(), ["scripts/balances.ts", "scripts/buy.ts", "scripts/demo-fork.ts", "scripts/e2e-fork.ts", "scripts/e2e-hire.ts", "scripts/e2e-live.ts", "scripts/verify-testnet.ts"], "the scripts that read RPC_URL");
  for (const f of readers) assert.match(readFileSync(f, "utf8"), /^exitRedacted\(\[/m, `${f} reads RPC_URL and does not redact what it prints`);
  assert.match(readFileSync("scripts/buy.ts", "utf8"), /\} catch \(e\) \{\n  console\.error\(safeMessage\(e, \[cfg\.rpcUrl\]\)\);/, "scripts/buy.ts prints its error without RPC_URL");
  // and no other file writes a public Robinhood Chain RPC out
  for (const f of files) {
    if (f === "src/config.ts") continue;
    assert.doesNotMatch(readFileSync(f, "utf8"), /rpc\.(?:mainnet|testnet)\.chain\.robinhood\.com/, `${f} names a public RPC`);
  }
});

test("parseUnitsStrict reads plain decimals exactly", () => {
  assert.equal(parseUnitsStrict("0.10", 6), 100_000n);
  assert.equal(parseUnitsStrict("0.1", 6), 100_000n);
  assert.equal(parseUnitsStrict("1", 6), 1_000_000n);
  assert.equal(parseUnitsStrict(" 2.5 ", 6), 2_500_000n);
  assert.equal(parseUnitsStrict("0.000001", 6), 1n);
  assert.equal(parseUnitsStrict("100", 18), 100n * 10n ** 18n);
});

test("parseUnitsStrict refuses anything that is not a plain non-negative decimal", () => {
  for (const bad of ["", " ", "-1", "+1", ".5", "1.", "1e3", "0x10", "1,5", "0.0000001", "1 000", "١"]) {
    assert.throws(() => parseUnitsStrict(bad, 6), ConfigError, `accepted "${bad}"`);
  }
});

test("formatUnits round-trips and trims zeros", () => {
  assert.equal(formatUnits(100_000n, 6), "0.1");
  assert.equal(formatUnits(1_000_000n, 6), "1");
  assert.equal(formatUnits(0n, 6), "0");
  assert.equal(formatUnits(10n * 10n ** 18n, 18), "10");
});

test("loadConfig defaults to testnet with USDG prices and no $WIF on testnet", () => {
  const c = loadConfig({ RPC_URL, PAY_TO });
  assert.equal(c.chain.caip2, "eip155:46630");
  assert.equal(c.prices.ask, 100_000n);
  assert.equal(c.prices.askHolder, 50_000n);
  assert.equal(c.wif.token, null);
  assert.equal(c.wif.cashback, 0n);
  assert.equal(c.wif.dailyBudget, 500n * 10n ** 18n);
  assert.equal(c.payTo, "0x00000000000000000000000000000000000000AA");
});

test("loadConfig on mainnet knows $WIF and normalises addresses in any case", () => {
  const c = loadConfig({ NETWORK: " Robinhood ".trim(), RPC_URL, PAY_TO: PAY_TO.toUpperCase().replace("0X", "0x") });
  assert.equal(c.chain.caip2, "eip155:4663");
  assert.equal(c.wif.token?.toLowerCase(), "0x5173b8ea6923c2d40267890d45c46a3480954773");
});

test("loadConfig refuses unsafe or broken settings", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /PAY_TO/],
    [{ RPC_URL, PAY_TO: "0x123" }, /not an address/],
    [{ RPC_URL, PAY_TO: "0X00000000000000000000000000000000000000aa" }, /not an address/],
    [{ RPC_URL, PAY_TO, NETWORK: "base" }, /NETWORK/],
    [{ RPC_URL, PAY_TO, PRICE_ASK_USDG: "0" }, /above zero/],
    [{ RPC_URL, PAY_TO, PRICE_ASK_HOLDER_USDG: "0.20" }, /holder price/],
    [{ RPC_URL, PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10" }, /MERCHANT_PRIVATE_KEY/],
    [{ RPC_URL, PAY_TO, WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /\$WIF token/],
    [{ RPC_URL, PAY_TO, NETWORK: "robinhood", WIF_WORKER_REWARD: "5", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /WORKER_TOKEN/],
    [{ RPC_URL, PAY_TO, PORT: "70000" }, /PORT/],
    [{ RPC_URL, PAY_TO, WIF_HOLDER_MIN: "0" }, /WIF_HOLDER_MIN/],
    [{ RPC_URL, PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10", WIF_DAILY_BUDGET: "9.99", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /WIF_DAILY_BUDGET is below one WIF_CASHBACK/],
    [{ RPC_URL, PAY_TO, NETWORK: "robinhood", WIF_WORKER_REWARD: "50", WIF_DAILY_BUDGET: "49", WORKER_TOKEN: "t", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /below one WIF_WORKER_REWARD/],
  ];
  for (const [env, msg] of cases) assert.throws(() => loadConfig(env), msg, JSON.stringify(env));
});

// a key one digit short, a key with a typo, and keys outside the curve: ethers would print each one whole
const BAD_KEYS = ["0x" + "de".repeat(31) + "f", "0x" + "de".repeat(31) + "zz", "0x" + "de".repeat(33), "0x" + "00".repeat(32), "0x" + "ff".repeat(32), "0x" + "de".repeat(31)];

test("a malformed private key is refused by name, and the message never contains it", () => {
  for (const bad of BAD_KEYS) {
    for (const env of [{ RPC_URL, PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: bad }, { RPC_URL, PAY_TO, MERCHANT_PRIVATE_KEY: bad }]) {
      let message = "";
      assert.throws(() => loadConfig(env), (e: unknown) => {
        message = (e as Error).message;
        return e instanceof ConfigError && /MERCHANT_PRIVATE_KEY/.test(message);
      }, bad);
      assert.ok(!message.toLowerCase().includes(bad.slice(2, 20).toLowerCase()), `the message carries the key: ${message}`);
    }
    assert.throws(() => privateKey({ PAYER_PRIVATE_KEY: bad }, "PAYER_PRIVATE_KEY"), /PAYER_PRIVATE_KEY .*not shown/);
  }
  // a good key passes, with or without 0x, and comes back with it
  const good = "de".repeat(32);
  assert.equal(privateKey({ K: good }, "K"), "0x" + good);
  assert.equal(privateKey({ K: ` 0x${good} ` }, "K"), "0x" + good);
  assert.equal(privateKey({ K: "" }, "K"), null);
  assert.equal(loadConfig({ RPC_URL, PAY_TO, MERCHANT_PRIVATE_KEY: good }).merchantKey, "0x" + good);
  // a key pasted into an address variable is not repeated back either
  for (const key of ["PAY_TO", "WIF_ADDRESS"]) {
    assert.throws(() => loadConfig({ RPC_URL, PAY_TO, [key]: "0x" + good }), (e: unknown) => {
      const m = (e as Error).message;
      return e instanceof ConfigError && m.startsWith(`${key} is not an address`) && !m.includes(good.slice(0, 20));
    }, key);
  }
});

test("confirms only the exact approved amount", () => {
  assert.equal(confirms("0.10", 100_000n, 6), true);
  assert.equal(confirms("0.1", 100_000n, 6), true);
  assert.equal(confirms(" 0.100 ", 100_000n, 6), true);
  for (const no of ["0.11", "0.09", "1", "", "abc", "0.1 USDG", "-0.1"]) assert.equal(confirms(no, 100_000n, 6), false, no);
  assert.equal(confirms(null, 100_000n, 6), false);
  assert.equal(confirms(undefined, 100_000n, 6), false);
});

test("the agent routes questions to a skill", () => {
  assert.equal(pickSkill("what does 0x5173b8ea6923c2d40267890d45c46a3480954773 hold?"), "address");
  assert.equal(pickSkill("How much $WIF is there?"), "wif");
  assert.equal(pickSkill("WORLD IS FLAT token"), "wif");
  assert.equal(pickSkill("which x402 schemes does the facilitator settle"), "facilitator");
  assert.equal(pickSkill("latest Block and gas?"), "block");
  assert.equal(pickSkill("tell me a joke"), "help");
  assert.equal(pickSkill("0x123 is not an address"), "help");
});
