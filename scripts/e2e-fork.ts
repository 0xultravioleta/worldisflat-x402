// `npm run e2e:fork`: the whole flow against a local anvil fork of Robinhood Chain, with nothing to configure and no
// real funds. Real USDG and $WIF bytecode, the real EIP-3009 settlement, the SDK on both sides; only the facilitator
// is a double (src/double/facilitator.ts) because the real one cannot see a local fork.
//
//   npm run e2e:fork                       # fork of mainnet (USDG + $WIF)
//   npm run e2e:fork -- robinhood-testnet  # fork of testnet (USDG only)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Wallet } from "ethers";
import { X402Client } from "uvd-x402-sdk";
import { createApp } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { CHAINS, USDG_DECIMALS, WIF_DECIMALS, formatUnits, loadConfig, type NetworkName } from "../src/config.js";
import { createFacilitatorDouble } from "../src/double/facilitator.js";
import { Store } from "../src/store.js";
import { balance, fundFromHolder, setEth, startFork } from "./lib/anvil.js";

// holders the fork borrows from (impersonated on the fork only): the Uniswap v4 PoolManager on mainnet, a large
// testnet USDG holder on testnet
const HOLDERS: Record<NetworkName, { usdg: string; wif: string | null }> = {
  robinhood: { usdg: "0x8366a39cc670b4001a1121b8f6a443a643e40951", wif: "0x8366a39cc670b4001a1121b8f6a443a643e40951" },
  "robinhood-testnet": { usdg: "0x545FA0D7993929FEf64158F68799E6fAdfbEb983", wif: null },
};

const network = (process.argv[2] ?? "robinhood") as NetworkName;
if (!(network in CHAINS)) throw new Error(`unknown network ${network}`);
const chainInfo = CHAINS[network];
const hasWif = chainInfo.wif !== null;
const port = (n: number) => 20000 + Math.floor(Math.random() * 20000) + n;

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${detail}`);
}

const fork = await startFork(chainInfo.rpcUrl, chainInfo.chainId, port(1));
const dataDir = mkdtempSync(path.join(tmpdir(), "flatfee-e2e-"));
const servers: { close: () => void }[] = [];
try {
  // throwaway wallets: keys live in memory for this run only
  const payer = Wallet.createRandom();
  const merchant = Wallet.createRandom();
  const worker = Wallet.createRandom();
  console.log(`fork of ${chainInfo.label} at ${fork.url}; payer ${payer.address}, merchant ${merchant.address}`);

  await fundFromHolder(fork, chainInfo.usdg, HOLDERS[network].usdg, payer.address, 5_000_000n); // 5 USDG
  if (hasWif) {
    await setEth(fork, merchant.address, 10n ** 16n);
    await fundFromHolder(fork, chainInfo.wif!, HOLDERS[network].wif!, merchant.address, 1_000n * 10n ** 18n);
  }

  const double = createFacilitatorDouble({ chain: chainInfo, rpcUrl: fork.url, settler: fork.settler });
  const facPort = port(2);
  servers.push(serve({ fetch: double.app.fetch, port: facPort }));

  const env: Record<string, string> = {
    NETWORK: network,
    RPC_URL: fork.url,
    FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
    PAY_TO: merchant.address,
    DATA_DIR: dataDir,
    WORKER_TOKEN: "e2e-worker",
  };
  if (hasWif) Object.assign(env, { MERCHANT_PRIVATE_KEY: merchant.privateKey, WIF_CASHBACK: "10", WIF_WORKER_REWARD: "50", WIF_HOLDER_MIN: "100" });
  const cfg = loadConfig(env);
  const chain = connectChain(cfg);
  const app = createApp({ cfg, chain, store: new Store(dataDir), log: () => {} });
  const appPort = port(3);
  servers.push(serve({ fetch: app.fetch, port: appPort }));
  const base = `http://127.0.0.1:${appPort}`;

  const usdg = (who: string) => balance(fork, chainInfo.usdg, who);
  const wif = (who: string) => (hasWif ? balance(fork, chainInfo.wif!, who) : Promise.resolve(0n));

  // 1. no payment: a 402 with the USDG terms on Robinhood Chain
  const r402 = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "latest block?" }) });
  const terms = (await r402.json()) as { accepts?: { network: string; asset: string; amount: string; payTo: string }[] };
  const offer = terms.accepts?.[0];
  check("402 challenge", r402.status === 402 && offer?.network === chainInfo.caip2 && offer?.asset === chainInfo.usdg && offer?.amount === "100000",
    `status ${r402.status}, ${offer?.amount} atomic USDG on ${offer?.network} to ${offer?.payTo}`);

  // 2. bad input is refused before any payment
  const r400 = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "  " }) });
  check("empty question refused unpaid", r400.status === 400, `status ${r400.status}`);

  // 3. the buyer pays with the SDK and gets the answer
  const client = new X402Client({ defaultChain: network, rpcOverrides: { [network]: fork.url } });
  await client.connectWithPrivateKey(payer.privateKey, network);
  const before = { payer: await usdg(payer.address), merchant: await usdg(merchant.address), wif: await wif(payer.address) };
  const paid = await client.fetch(`${base}/api/ask`, {
    method: "POST",
    maxAmount: "0.10",
    init: { headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What is the latest block and gas on the chain?" }) },
  });
  const body = (await paid.json()) as { answer?: string; receipt?: { settleTx?: string; tier?: string; cashback?: { tx?: string } | null } };
  const after = { payer: await usdg(payer.address), merchant: await usdg(merchant.address), wif: await wif(payer.address) };
  check("paid ask answered", paid.status === 200 && !!body.answer, `status ${paid.status}: ${body.answer?.slice(0, 90)}`);
  check("USDG moved payer -> merchant (0.10)", before.payer - after.payer === 100_000n && after.merchant - before.merchant === 100_000n,
    `payer -${formatUnits(before.payer - after.payer, USDG_DECIMALS)}, merchant +${formatUnits(after.merchant - before.merchant, USDG_DECIMALS)}, settle ${body.receipt?.settleTx}`);
  const settleReceipt = body.receipt?.settleTx ? await fork.provider.getTransactionReceipt(body.receipt.settleTx) : null;
  check("settle tx mined on the fork", settleReceipt?.status === 1, `tx ${body.receipt?.settleTx} status ${settleReceipt?.status}`);
  if (hasWif) {
    check("$WIF cashback reached the payer (10)", after.wif - before.wif === 10n * 10n ** 18n, `+${formatUnits(after.wif - before.wif, WIF_DECIMALS)} $WIF, tx ${body.receipt?.cashback?.tx}`);
  }

  // 3b. the landing page's wallet flow: public/x402-browser.js builds the payment, here signed by ethers instead of a wallet
  const browser = await import("../public/x402-browser.js" as string);
  const quote = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "help" }) });
  const quoteBody = (await quote.json()) as { accepts: Record<string, unknown>[] };
  const typed = browser.typedDataFor(quoteBody.accepts[0], payer.address);
  const browserSig = await payer.signTypedData(typed.domain, typed.types, typed.message);
  const browserHeader = browser.paymentHeader(quoteBody.accepts[0], typed, browserSig);
  const viaBrowser = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": browserHeader }, body: JSON.stringify({ question: "help" }) });
  check("landing-page payment accepted", viaBrowser.status === 200, `status ${viaBrowser.status} ${viaBrowser.status === 200 ? "" : (await viaBrowser.text()).slice(0, 300)}`);

  // 4. replaying the same X-PAYMENT is not served twice
  const p = await client.createPayment({ recipient: merchant.address, amount: "0.10", tokenType: "usdg" } as never);
  const once = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": p.paymentHeader }, body: JSON.stringify({ question: "help" }) });
  const twice = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": p.paymentHeader }, body: JSON.stringify({ question: "help" }) });
  check("same X-PAYMENT served once", once.status === 200 && twice.status !== 200, `first ${once.status}, replay ${twice.status}`);

  if (hasWif) {
    // 5. a $WIF holder pays the holder price (0.05): give the payer 100 $WIF in total
    const have = await wif(payer.address);
    if (have < 100n * 10n ** 18n) await fundFromHolder(fork, chainInfo.wif!, HOLDERS[network].wif!, payer.address, 100n * 10n ** 18n - have);
    const q = (await (await fetch(`${base}/api/quote?payer=${payer.address}`)).json()) as { tier: string; ask: string };
    const b2 = await usdg(payer.address);
    const r = await client.fetch(`${base}/api/ask`, {
      method: "POST",
      maxAmount: "0.10",
      init: { headers: { "content-type": "application/json", "x-payer": payer.address }, body: JSON.stringify({ question: `$WIF for ${payer.address}?` }) },
    });
    const a2 = await usdg(payer.address);
    check("holder tier pays 0.05", r.status === 200 && q.tier === "holder" && b2 - a2 === 50_000n, `quote ${q.tier} ${q.ask} USDG, charged ${formatUnits(b2 - a2, USDG_DECIMALS)}`);

    // 6. a non-holder signing the holder price is refused (the tier comes from the signed payer, not from a header)
    const stranger = Wallet.createRandom();
    await fundFromHolder(fork, chainInfo.usdg, HOLDERS[network].usdg, stranger.address, 1_000_000n);
    const sc = new X402Client({ defaultChain: network, rpcOverrides: { [network]: fork.url } });
    await sc.connectWithPrivateKey(stranger.privateKey, network);
    const cheap = await sc.createPayment({ recipient: merchant.address, amount: "0.05", tokenType: "usdg" } as never);
    const rc = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "x-payer": payer.address, "X-PAYMENT": cheap.paymentHeader }, body: JSON.stringify({ question: "help" }) });
    check("non-holder cannot pay the holder price", rc.status !== 200 && (await usdg(stranger.address)) === 1_000_000n, `status ${rc.status}, stranger USDG untouched`);
  }

  // 7. hire a human: pay, the task appears, a worker claims and completes it
  const hire = await client.fetch(`${base}/api/hire`, {
    method: "POST",
    maxAmount: "0.50",
    init: { headers: { "content-type": "application/json" }, body: JSON.stringify({ request: "Check that the cafe on 5th street is open and send a photo" }) },
  });
  const hired = (await hire.json()) as { task?: { id: string } };
  if (hire.status !== 201) console.log("hire answered", hire.status, JSON.stringify(hired).slice(0, 400));
  const id = hired.task?.id;
  check("paid hire created a task", hire.status === 201 && !!id, `status ${hire.status}, task ${id}`);
  const wh = { "content-type": "application/json", "x-worker-token": "e2e-worker" };
  const claim = await fetch(`${base}/api/tasks/${id}/claim`, { method: "POST", headers: wh, body: JSON.stringify({ worker: worker.address }) });
  const wifBefore = await wif(worker.address);
  const done = await fetch(`${base}/api/tasks/${id}/complete`, { method: "POST", headers: wh, body: JSON.stringify({ worker: worker.address, answer: "Open until 9pm, photo at ipfs://demo" }) });
  const task = (await done.json()) as { status?: string; rewardTx?: string; rewardError?: string };
  const reward = (await wif(worker.address)) - wifBefore;
  check("worker claimed and completed", claim.status === 200 && task.status === "done", `claim ${claim.status}, task ${task.status}`);
  if (hasWif) check("worker got the $WIF reward (50)", reward === 50n * 10n ** 18n, `+${formatUnits(reward, WIF_DECIMALS)} $WIF, tx ${task.rewardTx}${task.rewardError ? `, error: ${task.rewardError}` : ""}`);

  // 8. the double refuses what the real facilitator refuses (so the checks above cannot pass by a lax double)
  const accept = { scheme: "exact", network: chainInfo.caip2, asset: chainInfo.usdg, amount: "100000", payTo: merchant.address, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } };
  const bodyFor = async (over: { accept?: Record<string, unknown>; msg?: Record<string, string>; now?: number; sig?: (s: string) => string } = {}) => {
    const t = browser.typedDataFor(accept, payer.address, over.now ? { now: over.now } : {});
    Object.assign(t.message, over.msg ?? {});
    const s = await payer.signTypedData(t.domain, t.types, t.message);
    const req = { ...accept, ...(over.accept ?? {}) };
    return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: req, payload: { signature: over.sig ? over.sig(s) : s, authorization: t.message } }, paymentRequirements: req };
  };
  const refusals: [string, Awaited<ReturnType<typeof bodyFor>>, RegExp][] = [
    ["amount below the price", await bodyFor({ accept: { amount: "100001" } }), /value/],
    ["another recipient", await bodyFor({ accept: { payTo: worker.address } }), /recipient/],
    ["another asset", await bodyFor({ accept: { asset: "0x0000000000000000000000000000000000000001" } }), /asset/],
    ["another network", await bodyFor({ accept: { network: "eip155:8453" } }), /network/],
    ["expired", await bodyFor({ now: Math.floor(Date.now() / 1000) - 7200 }), /valid_before/],
    ["tampered signature", await bodyFor({ sig: (s) => s.slice(0, 10) + (s[10] === "0" ? "1" : "0") + s.slice(11) }), /signature/],
  ];
  const good = await double.verify(await bodyFor());
  check("double accepts a valid payment", good.isValid === true, `isValid ${good.isValid} ${good.invalidReason ?? ""}`);
  for (const [label, b, reason] of refusals) {
    const v = await double.verify(b);
    check(`double refuses: ${label}`, v.isValid === false && reason.test(v.invalidReason ?? ""), `${v.invalidReason}`);
  }

  const ledger = (await (await fetch(`${base}/api/ledger`)).json()) as unknown[];
  check("ledger lists the paid calls", ledger.length >= 3, `${ledger.length} entries`);
  console.log(`settlements by the double: ${double.settled.length}`);
} finally {
  for (const s of servers) s.close();
  fork.stop();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed on a fork of ${chainInfo.label}`);
process.exit(failed.length ? 1 : 0);
