import assert from "node:assert/strict";
import { test } from "node:test";
import { pickSkill } from "../src/agent.js";
import { ConfigError, formatUnits, loadConfig, parseUnitsStrict, privateKey } from "../src/config.js";
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
  assert.equal(c.wif.dailyBudget, 500n * 10n ** 18n);
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
    [{ PAY_TO, WIF_HOLDER_MIN: "0" }, /WIF_HOLDER_MIN/],
    [{ PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10", WIF_DAILY_BUDGET: "9.99", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /WIF_DAILY_BUDGET is below one WIF_CASHBACK/],
    [{ PAY_TO, NETWORK: "robinhood", WIF_WORKER_REWARD: "50", WIF_DAILY_BUDGET: "49", WORKER_TOKEN: "t", MERCHANT_PRIVATE_KEY: "0x" + "11".repeat(32) }, /below one WIF_WORKER_REWARD/],
  ];
  for (const [env, msg] of cases) assert.throws(() => loadConfig(env), msg, JSON.stringify(env));
});

// a key one digit short, a key with a typo, and keys outside the curve: ethers would print each one whole
const BAD_KEYS = ["0x" + "de".repeat(31) + "f", "0x" + "de".repeat(31) + "zz", "0x" + "de".repeat(33), "0x" + "00".repeat(32), "0x" + "ff".repeat(32), "0x" + "de".repeat(31)];

test("a malformed private key is refused by name, and the message never contains it", () => {
  for (const bad of BAD_KEYS) {
    for (const env of [{ PAY_TO, NETWORK: "robinhood", WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: bad }, { PAY_TO, MERCHANT_PRIVATE_KEY: bad }]) {
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
  assert.equal(loadConfig({ PAY_TO, MERCHANT_PRIVATE_KEY: good }).merchantKey, "0x" + good);
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
