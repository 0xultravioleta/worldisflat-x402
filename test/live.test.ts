import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { livePassed, liveRunRefusal } from "../scripts/lib/live.js";

const PAY_TO = "0x00000000000000000000000000000000000000aa";
const KEY = "0x" + "11".repeat(32);
const WIF = 10n * 10n ** 18n;
const mainnet = (env: Record<string, string> = {}) => loadConfig({ PAY_TO, NETWORK: "robinhood", ...env });

test("e2e:mainnet refuses before reading the chain unless the USDG spend and the $WIF cashback are both approved", () => {
  const withCashback = mainnet({ WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: KEY });
  assert.match(liveRunRefusal(withCashback, {}) ?? "", /CONFIRM_MAINNET_SPEND/);
  assert.match(liveRunRefusal(withCashback, { CONFIRM_MAINNET_SPEND: "0.10" }) ?? "", /CONFIRM_MAINNET_WIF=10/);
  assert.match(liveRunRefusal(withCashback, { CONFIRM_MAINNET_SPEND: "0.10", CONFIRM_MAINNET_WIF: "9" }) ?? "", /CONFIRM_MAINNET_WIF=10/);
  assert.equal(liveRunRefusal(withCashback, { CONFIRM_MAINNET_SPEND: "0.10", CONFIRM_MAINNET_WIF: "10" }), null);
  assert.equal(liveRunRefusal(withCashback, { CONFIRM_MAINNET_SPEND: "0.10", CONFIRM_MAINNET_WIF: "10.0" }), null);
});

test("e2e:mainnet will not settle USDG without the $WIF leg, even when CONFIRM_MAINNET_WIF is given", () => {
  // a .env copied from .env.example has WIF_CASHBACK=0
  for (const env of [{}, { CONFIRM_MAINNET_WIF: "10" }]) {
    assert.match(liveRunRefusal(mainnet(), { CONFIRM_MAINNET_SPEND: "0.10", ...env }) ?? "", /WIF_CASHBACK=10 and MERCHANT_PRIVATE_KEY/);
  }
});

test("a testnet run needs no approval", () => {
  assert.equal(liveRunRefusal(loadConfig({ PAY_TO }), {}), null);
});

test("a live run passes only when the call was served, the USDG moved and the whole cashback landed", () => {
  const tx = "0x" + "ab".repeat(32);
  const ok = { status: 200, usdgMoved: true, cashback: WIF, cashbackTx: tx, wifGained: WIF };
  assert.equal(livePassed(ok), true);
  assert.equal(livePassed({ ...ok, status: 500 }), false);
  assert.equal(livePassed({ ...ok, usdgMoved: false }), false);
  assert.equal(livePassed({ ...ok, cashbackTx: null }), false);
  assert.equal(livePassed({ ...ok, cashbackTx: "pending" }), false);
  assert.equal(livePassed({ ...ok, wifGained: 0n }), false);
  assert.equal(livePassed({ ...ok, cashback: 0n, cashbackTx: null, wifGained: 0n }), true);
});
