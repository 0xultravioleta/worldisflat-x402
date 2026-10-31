import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ledgerCashback, livePassed, liveRunRefusal, remoteRefusal } from "../scripts/lib/live.js";

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

test("a live run pays a running server (FLATFEE_URL) only when its /api/info matches .env", () => {
  const cfg = mainnet({ WIF_CASHBACK: "10", MERCHANT_PRIVATE_KEY: KEY });
  // what the deploy's /api/info answered on 2026-10-31, with this test's PAY_TO ($WIF is 0x5173…4773 there too)
  const info = {
    name: "Flat Fee",
    localFork: false,
    network: { name: "robinhood", caip2: "eip155:4663", chainId: 4663 },
    payTo: PAY_TO.toUpperCase().replace("0X", "0x"),
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    prices: { ask: { standard: "0.1", holder: "0.05" }, hire: { standard: "0.5", holder: "0.25" } },
    wif: { token: cfg.wif.token!, holderMin: "100", cashback: "10", workerReward: "50" },
  };
  assert.equal(remoteRefusal(cfg, info), null);
  assert.equal(remoteRefusal(cfg, { ...info, usdg: info.usdg.toLowerCase(), wif: { ...info.wif, token: info.wif.token.toUpperCase().replace("0X", "0x") } }), null);
  for (const [bad, why] of [
    [{ ...info, localFork: true }, /localFork/],
    [{ ...info, localFork: undefined }, /localFork/],
    [{ ...info, network: { ...info.network, caip2: "eip155:46630" } }, /network/],
    [{ ...info, payTo: "0x00000000000000000000000000000000000000bb" }, /pay-to/],
    [{ ...info, usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F" }, /USDG/],
    [{ ...info, wif: { ...info.wif, token: null } }, /\$WIF token/],
    [{ ...info, wif: { ...info.wif, cashback: "0" } }, /\$WIF cashback/],
    [{ ...info, prices: { ...info.prices, ask: { standard: "0.2", holder: "0.05" } } }, /ask price/],
    [{ ...info, prices: { ...info.prices, ask: { standard: "0.1", holder: "0.1" } } }, /holder ask price/],
  ] as const) {
    assert.match(remoteRefusal(cfg, bad) ?? "", why);
  }
  for (const junk of [null, "", [], { localFork: false }]) assert.match(remoteRefusal(cfg, junk) ?? "", /refusing/);
});

test("the cashback of a settlement is read from the server's ledger once it is recorded", () => {
  const settle = "0x" + "aa".repeat(32);
  const tx = "0x" + "bb".repeat(32);
  const entry = { settleTx: settle, cashbackTx: null as string | null };
  assert.equal(ledgerCashback([entry], settle), null);
  assert.equal(ledgerCashback([], settle), null);
  assert.equal(ledgerCashback({ error: "x" }, settle), null);
  assert.equal(ledgerCashback([{ ...entry, cashbackTx: "pending" }], settle), null);
  assert.deepEqual(ledgerCashback([{ settleTx: "0x" + "cc".repeat(32), cashbackTx: tx }, { ...entry, cashbackTx: tx }], settle.toUpperCase().replace("0X", "0x")), { tx, error: null });
  assert.deepEqual(ledgerCashback([{ ...entry, cashbackError: "insufficient funds" }], settle), { tx: null, error: "insufficient funds" });
  assert.deepEqual(ledgerCashback([{ ...entry, cashbackTx: tx, cashbackError: "not seen mined" }], settle), { tx, error: "not seen mined" });
});
