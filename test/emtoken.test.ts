// The token an Execution Market escrow is paid in, read from what EM really publishes: its production payment-config
// (GET https://api.execution.market/api/v1/h2a/payment-config, 2026-11-06 17:42:40Z, no credentials), kept byte for
// byte in test/fixtures/em-payment-config.json (sha256 be8183ae…c7b0a5). No network: the fixture is the response.
// On Robinhood Chain EM serves `usdc: null` and USDG under `tokens.USDG`; on Base and every USDC network, `usdc`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Wallet, getAddress, verifyTypedData } from "ethers";
import { ESCROW_PAYMENT_INFO_TYPEHASH, buildEscrowPreAuth, computeEscrowNonce } from "uvd-x402-sdk";
import { CHAINS, loadConfig } from "../src/config.js";
import { EscrowRefused, escrowNetwork, escrowPaymentAuth, escrowReadiness, escrowToken, typedDataSigner, type BuildPreAuth } from "../src/escrow.js";

type Any = any;
const RECORDED: Any = JSON.parse(readFileSync(new URL("./fixtures/em-payment-config.json", import.meta.url), "utf8"));
const NETWORKS: Record<string, Any> = RECORDED.escrow.networks;
const RH = NETWORKS.robinhood;
const BASE = NETWORKS.base;
const RECEIVE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

const merchant = Wallet.createRandom();
const worker = Wallet.createRandom().address;
const deadline = Math.floor(Date.now() / 1000) + 86400;
/** Flat Fee on Robinhood Chain mainnet, configured with the escrow contracts EM publishes there */
const config = (env: Record<string, string> = {}) => {
  const c = loadConfig({
    NETWORK: "robinhood",
    PAY_TO: merchant.address,
    MERCHANT_PRIVATE_KEY: merchant.privateKey,
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    EM_ESCROW_ADDRESS: RH.escrow,
    EM_OPERATOR_ADDRESS: RH.operator,
    EM_TOKEN_COLLECTOR_ADDRESS: RH.token_collector,
    ...env,
  });
  return { ...c, em: c.em! };
};
const cfg = config();
/** the recorded response, with its Robinhood entry changed */
const withRobinhood = (change: Any) => ({ ...RECORDED, escrow: { ...RECORDED.escrow, networks: { ...NETWORKS, robinhood: { ...RH, ...change } } } });
/** a builder that only keeps the network config it was handed, and signs nothing */
const spy = () => {
  const calls: Any[] = [];
  const build: BuildPreAuth = async (_signer, p) => {
    calls.push(p.networkConfig);
    throw new Error("spy: nothing is signed");
  };
  return { calls, build };
};

test("Robinhood as EM serves it (usdc null): the escrow is built with tokens.USDG, its address and its domain", async () => {
  // what the fixture is about
  assert.equal(RH.usdc, null);
  assert.deepEqual(escrowToken("robinhood", RH, "USDG"), { address: CHAINS.robinhood.usdg, domainName: "Global Dollar", domainVersion: "1" });
  const n = escrowNetwork(cfg, RECORDED);
  assert.equal(n.chain_id, 4663);
  assert.equal(n.usdc, CHAINS.robinhood.usdg);
  assert.equal(n.usdc_domain_name, "Global Dollar");
  assert.equal(n.usdc_domain_version, "1");
  assert.equal(n.escrow, getAddress(RH.escrow));
  assert.equal(n.operator, getAddress(RH.operator));
  assert.equal(n.token_collector, getAddress(RH.token_collector));
  assert.deepEqual(n.tiers, { micro: RECORDED.escrow.tier_timings.micro });
  // and that is exactly what the builder is handed to sign with
  const s = spy();
  await assert.rejects(escrowPaymentAuth({ cfg, wallet: merchant, build: s.build }, RECORDED, worker, deadline), EscrowRefused);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.calls[0], n);
});

test("Robinhood with h2a.py's USDC fallback at the top (USD Coin / 2): still USDG's domain, from tokens.USDG", () => {
  // production serves Global Dollar / 1 at the top today (h2a.py found it in its SDK's registry); USD Coin / 2 is what
  // h2a.py serves when that lookup finds nothing: the escrow must not be signed under it
  const fallback = withRobinhood({ usdc_domain_name: "USD Coin", usdc_domain_version: "2" });
  const n = escrowNetwork(cfg, fallback);
  assert.equal(n.usdc, CHAINS.robinhood.usdg);
  assert.equal(n.usdc_domain_name, "Global Dollar");
  assert.equal(n.usdc_domain_version, "1");
  // the symbol is matched in any case, on either side
  const want = { address: CHAINS.robinhood.usdg, domainName: "Global Dollar", domainVersion: "1" };
  assert.deepEqual(escrowToken("robinhood", RH, "usdg"), want);
  assert.deepEqual(escrowToken("robinhood", { ...RH, tokens: { usdg: RH.tokens.USDG } }, "USDG"), want);
  // an absent usdc is the same as a null one
  const { usdc: _gone, ...noUsdc } = RH;
  assert.deepEqual(escrowToken("robinhood", noUsdc, "USDG"), want);
});

test("Base as EM serves it: still USDC with USDC's own domain, and every network that names a usdc is read as before", () => {
  assert.deepEqual(escrowToken("base", BASE, "USDG"), { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", domainName: "USD Coin", domainVersion: "2" });
  for (const [name, row] of Object.entries(NETWORKS)) {
    if (row.usdc === null) continue;
    for (const symbol of ["USDG", "USDC"]) {
      assert.deepEqual(escrowToken(name, row, symbol), { address: row.usdc, domainName: row.usdc_domain_name, domainVersion: row.usdc_domain_version }, `${name} ${symbol}`);
    }
  }
  // Robinhood is the only network of the recorded response without a usdc
  assert.deepEqual(Object.keys(NETWORKS).filter((k) => NETWORKS[k].usdc === null), ["robinhood"]);
  // and Flat Fee on Robinhood never takes Base's escrow for its own
  assert.throws(() => escrowNetwork(cfg, withRobinhood(BASE)), /another chain/);
});

test("Base as EM serves it, through the SDK's own builder: the merchant signs USDC under USD Coin / 2", async () => {
  const t = escrowToken("base", BASE, "USDG");
  const raw = await buildEscrowPreAuth(typedDataSigner(merchant), {
    networkConfig: {
      chain_id: BASE.chain_id,
      operator: BASE.operator,
      escrow: BASE.escrow,
      token_collector: BASE.token_collector,
      usdc: t.address as string,
      usdc_domain_name: t.domainName as string,
      usdc_domain_version: t.domainVersion as string,
      payment_info_typehash: RECORDED.escrow.payment_info_typehash,
    },
    network: "base",
    payerWallet: merchant.address,
    workerWallet: worker,
    bountyAtomic: "200000",
    reviewDeadlineSec: deadline,
  });
  const w = JSON.parse(raw);
  assert.equal(getAddress(w.payload.paymentInfo.token), getAddress(BASE.usdc));
  const domain = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: BASE.usdc };
  assert.equal(verifyTypedData(domain, { ReceiveWithAuthorization: RECEIVE }, w.payload.authorization, w.payload.signature), merchant.address);
  assert.equal(w.payload.authorization.nonce, computeEscrowNonce(8453, BASE.escrow, ESCROW_PAYMENT_INFO_TYPEHASH, w.payload.paymentInfo));
});

test("a network that names no token fails closed, says so, and nothing is signed", async () => {
  const none = withRobinhood({ tokens: {} }); // what EM serves where USDG is not enabled for payments
  const noToken = (e: unknown) => e instanceof EscrowRefused && /does not take USDG on robinhood: its escrow there names no token/.test(e.message);
  const cases: [string, Any][] = [
    ["empty tokens", none],
    ["no tokens", withRobinhood({ tokens: undefined })],
    ["null tokens", withRobinhood({ tokens: null })],
    ["tokens as a list", withRobinhood({ tokens: [RH.tokens.USDG] })],
    ["only another token", withRobinhood({ tokens: { USDC: { ...RH.tokens.USDG } } })],
  ];
  for (const [what, pc] of cases) assert.throws(() => escrowNetwork(cfg, pc), noToken, what);
  // USDG listed twice in two cases: neither is taken, and neither is a usdc beside them
  const twice = { USDG: RH.tokens.USDG, usdg: RH.tokens.USDG };
  for (const pc of [withRobinhood({ tokens: twice }), withRobinhood({ tokens: twice, usdc: RH.tokens.USDG.address, usdc_domain_name: "Global Dollar", usdc_domain_version: "1" })]) {
    assert.throws(() => escrowNetwork(cfg, pc), (e: unknown) => e instanceof EscrowRefused && /lists USDG more than once on robinhood/.test(e.message));
  }
  // the token looked up is the one Flat Fee publishes its tasks in (EM_PAYMENT_TOKEN), not USDG whatever it says
  assert.throws(() => escrowNetwork(config({ EM_PAYMENT_TOKEN: "USDC" }), RECORDED), /does not take USDC on robinhood: its escrow there names no token/);
  assert.equal(escrowNetwork(config({ EM_PAYMENT_TOKEN: "usdg" }), RECORDED).usdc, CHAINS.robinhood.usdg);
  const s = spy();
  assert.match((await escrowReadiness(cfg, none, s.build))!, /names no token/);
  await assert.rejects(escrowPaymentAuth({ cfg, wallet: merchant, build: s.build }, none, worker, deadline), noToken);
  assert.equal(s.calls.length, 0);
});

test("the token EM names must be Flat Fee's USDG, under USDG's domain compared exactly, or nothing is signed", async () => {
  const usdg = RH.tokens.USDG;
  const cases: [string, Any, RegExp][] = [
    ["another address", { tokens: { USDG: { ...usdg, address: CHAINS["robinhood-testnet"].usdg } } }, /token on robinhood is not the one/],
    ["an empty usdc, no USDG listed", { usdc: "", tokens: {} }, /token on robinhood is not the one/],
    ["a usdc that is not USDG, no USDG listed", { usdc: BASE.usdc, usdc_domain_name: "Global Dollar", usdc_domain_version: "1", tokens: undefined }, /token on robinhood is not the one/],
    ["USDG without an address", { tokens: { USDG: { ...usdg, address: undefined } } }, /token on robinhood is not the one/],
    ["a null USDG", { tokens: { USDG: null } }, /token on robinhood is not the one/],
    ["USDC's domain", { tokens: { USDG: { ...usdg, domain_name: "USD Coin", domain_version: "2" } } }, /domain on robinhood is not USDG's/],
    ["lower case", { tokens: { USDG: { ...usdg, domain_name: "global dollar" } } }, /domain on robinhood is not USDG's/],
    ["a trailing space", { tokens: { USDG: { ...usdg, domain_name: "Global Dollar " } } }, /domain on robinhood is not USDG's/],
    ["version 2", { tokens: { USDG: { ...usdg, domain_version: "2" } } }, /domain on robinhood is not USDG's/],
    ["version as a number", { tokens: { USDG: { ...usdg, domain_version: 1 } } }, /domain on robinhood is not USDG's/],
    ["no domain name", { tokens: { USDG: { ...usdg, domain_name: undefined } } }, /domain on robinhood is not USDG's/],
    ["no domain version", { tokens: { USDG: { ...usdg, domain_version: undefined } } }, /domain on robinhood is not USDG's/],
  ];
  for (const [what, change, why] of cases) {
    const pc = withRobinhood(change);
    assert.throws(() => escrowNetwork(cfg, pc), (e: unknown) => e instanceof EscrowRefused && why.test(e.message), what);
    const s = spy();
    assert.match((await escrowReadiness(cfg, pc, s.build))!, why, what);
    assert.equal(s.calls.length, 0, what);
  }
  // a listed USDG is the token whatever `usdc` says beside it (h2a.py fills `usdc` from its whole registry, enabled or not)
  for (const usdc of ["", BASE.usdc, CHAINS.robinhood.usdg]) {
    const n = escrowNetwork(cfg, withRobinhood({ usdc, usdc_domain_name: "USD Coin", usdc_domain_version: "2" }));
    assert.deepEqual([n.usdc, n.usdc_domain_name, n.usdc_domain_version], [CHAINS.robinhood.usdg, "Global Dollar", "1"], usdc);
  }
  // the refusal never repeats what EM sent: it lands in the public task and in the 503
  assert.throws(() => escrowNetwork(cfg, withRobinhood({ tokens: { USDG: { ...usdg, domain_name: "<script>" } } })), (e: Error) => !e.message.includes("<script>"));
});

test("a usdc that is USDG, where EM lists its tokens without USDG, is refused before the 402: EM does not take USDG there", async () => {
  const pc = withRobinhood({ usdc: CHAINS.robinhood.usdg, usdc_domain_name: "Global Dollar", usdc_domain_version: "1", tokens: { USDC: { address: BASE.usdc, domain_name: "USD Coin", domain_version: "2" } } });
  // the escrow itself would be Flat Fee's own: only the list of tokens EM takes says no
  assert.equal(escrowNetwork(cfg, pc).usdc, CHAINS.robinhood.usdg);
  const s = spy();
  assert.equal(await escrowReadiness(cfg, pc, s.build), "Execution Market does not take USDG on robinhood");
  assert.equal(s.calls.length, 0);
  // with no list at all there is nothing to say no: the dry run goes on to the builder
  await escrowReadiness(cfg, withRobinhood({ usdc: CHAINS.robinhood.usdg, usdc_domain_name: "Global Dollar", usdc_domain_version: "1", tokens: undefined }), s.build);
  assert.equal(s.calls.length, 1);
});
