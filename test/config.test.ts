import assert from "node:assert/strict";
import { test } from "node:test";
import { pickSkill } from "../src/agent.js";
import { ConfigError, formatUnits, loadConfig, parseUnitsStrict } from "../src/config.js";
import { confirms } from "../scripts/lib/buyer.js";

const PAY_TO = "0x00000000000000000000000000000000000000aa";

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
  const c = loadConfig({ PAY_TO });
  assert.equal(c.chain.caip2, "eip155:46630");
  assert.equal(c.prices.ask, 100_000n);
  assert.equal(c.prices.askHolder, 50_000n);
  assert.equal(c.wif.token, null);
  assert.equal(c.wif.cashback, 0n);
  assert.equal(c.payTo, "0x00000000000000000000000000000000000000AA");
});

test("loadConfig on mainnet knows $WIF and normalises addresses in any case", () => {
  const c = loadConfig({ NETWORK: " Robinhood ".trim(), PAY_TO: PAY_TO.toUpperCase().replace("0X", "0x") });
  assert.equal(c.chain.caip2, "eip155:4663");
  assert.equal(c.wif.token?.toLowerCase(), "0x5173b8ea6923c2d40267890d45c46a3480954773");
});

test("loadConfig refuses unsafe or broken settings", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{}, /PAY_TO/],
    [{ PAY_TO: "0x123" }, /not an address/],
    [{ PAY_TO: "0X00000000000000000000000000000000000000aa" }, /not an address/],
    [{ PAY_TO, NETWORK: "base" }, /NETWORK/],
    [{ PAY_TO, PRICE_ASK_USDG: "0" }, /above zero/],
    [{ PAY_TO, PRICE_ASK_HOLDER_USDG: "0.20" }, /holder price/],
    [{ PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10" }, /MERCHANT_PRIVATE_KEY/],
    [{ PAY_TO, WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /\$WIF token/],
    [{ PAY_TO, NETWORK: "robinhood", WIF_WORKER_REWARD: "5", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /WORKER_TOKEN/],
    [{ PAY_TO, PORT: "70000" }, /PORT/],
  ];
  for (const [env, msg] of cases) assert.throws(() => loadConfig(env), msg, JSON.stringify(env));
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
