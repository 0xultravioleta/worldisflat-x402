// The proof on the landing page (GET /api/proof, src/proof.ts; public/page-state.js proofCopy): every figure is a count
// of transactions in the dated reads of docs/evidence plus this server's own settlements, each transaction once, and
// a figure that was not read shows "—", never 0. No RPC, no network: the evidence files are read from disk.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { EVIDENCE_FILES, TEST_WORKER_LABEL, buildProof, loadEvidence, type Evidence } from "../src/proof.js";
import { Store, type LedgerEntry, type Task } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { plain, proofCopy, utcDate } from "../public/page-state.js";

const MERCHANT = "0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6";
const FACILITATOR = "0x103040545AC5031A11E8C03dd11324C7333a13C7";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const dirs: string[] = [];
const servers: { close: () => void }[] = [];
// this file's own port range: the test files run in parallel, each in a range of its own
let nextPort = 41400 + Math.floor(Math.random() * 250);

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "flatfee-proof-"));
  dirs.push(d);
  return d;
};
const mainnet = (env: Record<string, string> = {}) =>
  loadConfig({ NETWORK: "robinhood", RPC_URL: "http://127.0.0.1:9", PAY_TO: MERCHANT, DATA_DIR: tmp(), ...env });
const raw = JSON.parse(readFileSync(EVIDENCE_FILES[0], "utf8"));
const swarmRaw = JSON.parse(readFileSync(EVIDENCE_FILES[1], "utf8"));
const hash = (b: string) => `0x${b.repeat(32)}`;

test("the dated reads, as the live merchant on mainnet: 4 paid calls (0.60 USDG), 140 $WIF in 6 transfers, 2 escrows, 6 swarm tasks", () => {
  const ev = loadEvidence();
  assert.ok(ev);
  const p = buildProof(mainnet(), ev, [], [], "2026-11-12T18:00:00.000Z");
  assert.deepEqual(p.snapshot, { readAt: raw.read_at, block: raw.merchant_transfers.to_block });
  assert.equal(p.merchantUrl, `${EXPLORER}/address/${MERCHANT}`);
  assert.equal(p.paidCalls.count, 4);
  assert.equal(p.paidCalls.amount, "0.6");
  assert.equal(p.wif.count, 6);
  assert.equal(p.wif.amount, "140.0");
  assert.deepEqual(p.wif.cashback, { count: 4, amount: "40.0" });
  assert.deepEqual(p.wif.rewards, { count: 2, amount: "100.0" });
  assert.equal(p.escrows.count, 2);
  assert.equal(p.escrows.amount, "0.4");
  assert.equal(p.swarmPaid, 6);
  // every counted transaction is one the evidence holds, linked to the explorer, newest first, and counted once
  const recorded = new Set([
    ...raw.merchant_transfers.items.map((t: { tx: string }) => t.tx),
    ...[...raw.execution_market.tasks, ...swarmRaw.execution_market.tasks].flatMap((t: { escrow_tx?: { tx: string } | null }) => (t.escrow_tx ? [t.escrow_tx.tx] : [])),
  ]);
  const all = [...p.paidCalls.txs, ...p.wif.txs, ...p.escrows.txs];
  assert.equal(new Set(all.map((t) => t.tx)).size, all.length);
  for (const t of all) {
    assert.ok(recorded.has(t.tx), t.tx);
    assert.equal(t.url, `${EXPLORER}/tx/${t.tx}`);
    assert.equal(t.source, "chain");
  }
  for (const list of [p.paidCalls.txs, p.wif.txs, p.escrows.txs]) assert.deepEqual(list.map((t) => t.at), list.map((t) => t.at).sort().reverse());
  // the six $WIF transfers are the six hashes SUBMISSION.md gives the form
  const sub = readFileSync("SUBMISSION.md", "utf8");
  for (const t of p.wif.txs) assert.ok(sub.includes(t.tx), t.tx);
});

test("the work cards: Flat Fee's two hires with their test worker named as such, and the swarm's six tasks, never Flat Fee's", () => {
  const p = buildProof(mainnet(), loadEvidence(), [], [], "2026-11-12T18:00:00.000Z");
  const hires = p.work.filter((w) => w.kind === "flatfee");
  const swarm = p.work.filter((w) => w.kind === "swarm");
  assert.deepEqual(hires.map((w) => w.ref).sort(), ["3175424d", "d161b088"]);
  assert.equal(swarm.length, 6);
  for (const w of hires) {
    assert.equal(w.to, TEST_WORKER_LABEL);
    assert.match(w.from, /^Flat Fee · ERC-8004 agent (22487|1170265)$/);
    assert.equal(w.status, "released");
    assert.equal(w.bounty, "0.2");
    assert.equal(w.paid, "0.174");
    assert.ok(w.page?.startsWith(`https://execution.market/tasks/${w.ref}-`), String(w.page));
  }
  // the 7 Nov hire was published as the Base identity, the 8 Nov one as the Robinhood Chain one
  assert.equal(hires.find((w) => w.ref === "3175424d")!.from, "Flat Fee · ERC-8004 agent 1170265");
  assert.equal(hires.find((w) => w.ref === "d161b088")!.from, "Flat Fee · ERC-8004 agent 22487");
  for (const w of swarm) {
    assert.doesNotMatch(`${w.from} ${w.to}`, /Flat Fee/);
    assert.match(w.from, /^kk-0x(yuls|jokker) · ERC-8004 agent 2339[45]$/);
    assert.match(w.to, /^kk-(coordinator|trader) \(KarmaKadabra\)$/);
    assert.equal(w.bounty, "0.01");
    assert.equal(w.paid, "0.0087");
    assert.ok(w.paymentTx && w.paymentUrl === `${EXPLORER}/tx/${w.paymentTx}`);
  }
  // c59942f9's lock is not in the record: no lock link is made up for it
  const c599 = swarm.find((w) => w.ref === "c59942f9")!;
  assert.equal(c599.escrowTx, null);
  assert.equal(c599.escrowUrl, null);
  // newest first
  assert.deepEqual(p.work.map((w) => w.at), p.work.map((w) => w.at).sort().reverse());
});

test("the dated reads count only for the merchant they are about, on mainnet", () => {
  const ev = loadEvidence();
  for (const cfg of [mainnet({ PAY_TO: Wallet.createRandom().address }), loadConfig({ NETWORK: "robinhood-testnet", RPC_URL: "http://127.0.0.1:9", PAY_TO: MERCHANT, DATA_DIR: tmp() })]) {
    const p = buildProof(cfg, ev, [], [], "2026-11-12T18:00:00.000Z");
    assert.equal(p.snapshot, null);
    assert.equal(p.paidCalls.count, 0);
    assert.equal(p.wif.count, 0);
    assert.equal(p.escrows.count, 0);
    assert.equal(p.swarmPaid, 0);
    assert.deepEqual(p.work, []);
  }
  // the merchant matches whatever its case
  assert.ok(buildProof(mainnet({ PAY_TO: MERCHANT.toLowerCase() }), ev, [], [], "x").snapshot);
});

test("a paid call is USDG into the merchant in a transaction the facilitator sent: funding, outflows and other tokens are not", () => {
  const ev: Evidence = {
    readAt: "2026-11-12T03:14:35Z",
    block: 1,
    merchant: MERCHANT,
    facilitator: FACILITATOR,
    tasks: [],
    swarmWorkers: {},
    swarmAgents: {},
    transfers: [
      { token: "USDG", from: "0x1111111111111111111111111111111111111111", to: MERCHANT.toLowerCase(), amount: "0.1", tx: hash("a1"), at: "2026-11-01T00:00:01Z", sender: FACILITATOR.toLowerCase() },
      // the merchant's own funding: not sent by the facilitator
      { token: "USDG", from: "0x2222222222222222222222222222222222222222", to: MERCHANT, amount: "5", tx: hash("a2"), at: "2026-11-01T00:00:02Z", sender: "0x2222222222222222222222222222222222222222" },
      // USDG out of the merchant (an escrow lock), sent by the facilitator
      { token: "USDG", from: MERCHANT, to: "0x3333333333333333333333333333333333333333", amount: "0.2", tx: hash("a3"), at: "2026-11-01T00:00:03Z", sender: FACILITATOR },
      // $WIF into the merchant
      { token: "$WIF", from: "0x1111111111111111111111111111111111111111", to: MERCHANT, amount: "10", tx: hash("a4"), at: "2026-11-01T00:00:04Z", sender: FACILITATOR },
      // $WIF out: to the payer of a call (cashback), and to someone who never paid (a worker's reward)
      { token: "$WIF", from: MERCHANT, to: "0x1111111111111111111111111111111111111111", amount: "10", tx: hash("a5"), at: "2026-11-01T00:00:05Z", sender: MERCHANT },
      { token: "$WIF", from: MERCHANT, to: "0x4444444444444444444444444444444444444444", amount: "50", tx: hash("a6"), at: "2026-11-01T00:00:06Z", sender: MERCHANT },
    ],
  };
  const p = buildProof(mainnet(), ev, [], [], "x");
  assert.deepEqual(p.paidCalls.txs.map((t) => t.tx), [hash("a1")]);
  assert.equal(p.paidCalls.amount, "0.1");
  assert.deepEqual(p.wif.txs.map((t) => [t.tx, t.kind]), [[hash("a6"), "reward"], [hash("a5"), "cashback"]]);
  assert.deepEqual(p.wif.cashback, { count: 1, amount: "10.0" });
  assert.deepEqual(p.wif.rewards, { count: 1, amount: "50.0" });
  assert.equal(p.escrows.count, 0);
});

test("this server's own settlements add to the dated reads, each transaction once; a failed cashback or reward is not counted", () => {
  const cfg = mainnet({ WIF_CASHBACK: "10", WIF_WORKER_REWARD: "50", MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey, WORKER_TOKEN: "a-worker-token-of-16+" });
  const ev = loadEvidence()!;
  const known = ev.transfers.find((t) => t.token === "USDG" && t.to.toLowerCase() === MERCHANT.toLowerCase())!;
  const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
    id: over.id ?? "1",
    kind: "ask",
    at: "2026-11-13T10:00:00.000Z",
    network: "eip155:4663",
    payer: "0x1111111111111111111111111111111111111111",
    tier: "standard",
    price: "100000",
    settleTx: null,
    cashbackTx: null,
    ...over,
  });
  const ledger = [
    entry({ id: "a", settleTx: hash("b1"), cashbackTx: hash("b2") }),
    // the same settlement the dated read already has: not counted twice
    entry({ id: "b", settleTx: known.tx, at: known.at }),
    // a cashback that failed: not counted
    entry({ id: "c", settleTx: hash("b3"), cashbackTx: hash("b4"), cashbackError: "reverted" }),
    // no settlement hash, no row
    entry({ id: "d", settleTx: null }),
    // not a hash: not counted
    entry({ id: "e", settleTx: "pending" }),
  ];
  const task = (over: Partial<Task>): Task => ({ id: "t", createdAt: "2026-11-13T10:00:00.000Z", status: "done", request: "r", payer: "0x1111111111111111111111111111111111111111", paidTx: null, worker: null, answer: "a", doneAt: "2026-11-13T11:00:00.000Z", rewardTx: null, ...over });
  const tasks = [task({ id: "t1", rewardTx: hash("c1") }), task({ id: "t2", rewardTx: hash("c2"), rewardError: "not mined" })];
  const p = buildProof(cfg, ev, ledger, tasks, "2026-11-13T09:00:00.000Z");
  assert.equal(p.paidCalls.count, 4 + 2);
  assert.equal(p.paidCalls.amount, "0.8");
  const server = p.paidCalls.txs.filter((t) => t.source === "server").map((t) => t.tx).sort();
  assert.deepEqual(server, [hash("b1"), hash("b3")].sort());
  assert.deepEqual(p.wif.cashback, { count: 5, amount: "50.0" });
  assert.deepEqual(p.wif.rewards, { count: 3, amount: "150.0" });
  assert.equal(p.serverSince, "2026-11-13T09:00:00.000Z");
});

test("a hire this server published on Execution Market shows as a card and its escrow counts, with the configured bounty", () => {
  const cfg = mainnet({
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    EM_ESCROW_ADDRESS: Wallet.createRandom().address,
    EM_OPERATOR_ADDRESS: Wallet.createRandom().address,
    EM_TOKEN_COLLECTOR_ADDRESS: Wallet.createRandom().address,
    EM_BOUNTY_USDG: "0.2",
  });
  const em = { step: "assigned", key: "k", taskId: "aaaaaaaa-0000-4000-8000-000000000000", status: "accepted", deadline: null, executorId: "e", workerWallet: "0x5555555555555555555555555555555555555555", escrowTx: hash("d1"), skipped: [], signed: [], accepted: null, approvals: 0, needsOrder: false, assignedAt: "2026-11-13T12:00:00.000Z", rejected: [], approval: null, paymentTx: null, lastError: null, updatedAt: "2026-11-13T12:00:00.000Z" };
  const t: Task = { id: "t9", createdAt: "2026-11-13T11:59:00.000Z", status: "open", request: "Check the cafe.", payer: "0x1111111111111111111111111111111111111111", paidTx: hash("d0"), worker: null, answer: null, doneAt: null, rewardTx: null, via: "em", em: em as Task["em"] };
  const p = buildProof(cfg, loadEvidence(), [], [t], "x");
  assert.equal(p.escrows.count, 3);
  assert.equal(p.escrows.amount, "0.6");
  const card = p.work[0];
  assert.equal(card.ref, "aaaaaaaa");
  assert.equal(card.kind, "flatfee");
  assert.equal(card.status, "assigned");
  assert.equal(card.bounty, "0.2");
  assert.equal(card.escrowUrl, `${EXPLORER}/tx/${hash("d1")}`);
  assert.equal(card.page, "https://execution.market/tasks/aaaaaaaa-0000-4000-8000-000000000000");
  // a task the dated read already shows is not drawn twice
  const again = { ...t, em: { ...em, taskId: "d161b088-ae87-44df-8ed3-5af09018c779", escrowTx: null } as Task["em"] };
  assert.equal(buildProof(cfg, loadEvidence(), [], [again], "x").work.filter((w) => w.ref === "d161b088").length, 1);
});

test("the evidence files: without the merchant's read there is no proof from it; a later file that cannot be read is skipped", () => {
  const files: Record<string, string> = { a: readFileSync(EVIDENCE_FILES[0], "utf8"), b: readFileSync(EVIDENCE_FILES[1], "utf8") };
  const read = (f: string) => {
    if (!(f in files)) throw new Error("ENOENT");
    return files[f];
  };
  assert.equal(loadEvidence(["missing", "b"], read), null);
  assert.equal(loadEvidence(["b"], read), null, "the swarm file alone is not a read of the merchant");
  files.bad = "{ not json";
  assert.equal(loadEvidence(["bad"], read), null);
  const onlyMain = loadEvidence(["a", "missing"], read)!;
  assert.equal(onlyMain.tasks.length, raw.execution_market.tasks.length);
  const both = loadEvidence(["a", "b"], read)!;
  assert.equal(both.tasks.length, raw.execution_market.tasks.length + swarmRaw.execution_market.tasks.length);
  assert.equal(both.swarmAgents["0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b"], "kk-trader");
});

test("the image carries the evidence the server reads", () => {
  const docker = readFileSync("Dockerfile", "utf8");
  assert.match(docker, /^COPY docs\/evidence \.\/docs\/evidence$/m);
  for (const f of EVIDENCE_FILES) assert.ok(f.startsWith("docs/evidence/"), f);
  assert.doesNotMatch(readFileSync(".dockerignore", "utf8"), /^docs/m);
});

test("GET /api/proof on the live demo's wallet serves the figures; every server answers it", async () => {
  const chain: Chain = { provider: {} as JsonRpcProvider, merchantAddress: null, balanceOf: async () => 0n, tierOf: async () => "standard", sendWif: async () => { throw new Error("no"); } };
  const cfg = mainnet();
  const store = new Store(cfg.dataDir);
  const app = createApp({ cfg, chain, store, log: () => {} });
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  const p = await (await fetch(`http://127.0.0.1:${port}/api/proof`)).json();
  assert.equal(p.paidCalls.count, 4);
  assert.equal(p.swarmPaid, 6);
  assert.ok(p.snapshot);
  // a call this server settles shows up on the next read, on top of the dated ones
  store.addLedger({ kind: "ask", network: "eip155:4663", payer: Wallet.createRandom().address, tier: "standard", price: "100000", settleTx: hash("e1"), cashbackTx: null });
  const after1 = await (await fetch(`http://127.0.0.1:${port}/api/proof`)).json();
  assert.equal(after1.paidCalls.count, 5);
  assert.equal(after1.paidCalls.amount, "0.7");
  assert.deepEqual(after1.paidCalls.txs.filter((t: { source: string }) => t.source === "server").map((t: { tx: string }) => t.tx), [hash("e1")]);
  // with no evidence at all, the figures are empty and the page says nothing was read
  const none = createApp({ cfg, chain, store: new Store(tmp()), log: () => {}, evidence: null });
  const port2 = nextPort++;
  servers.push(serve({ fetch: none.fetch, port: port2 }));
  const q = await (await fetch(`http://127.0.0.1:${port2}/api/proof`)).json();
  assert.equal(q.snapshot, null);
  assert.equal(q.paidCalls.count, 0);
  assert.equal(proofCopy(q).calls, "—");
});

test("the proof strip's words: figures only when read, '—' and a reason otherwise, never 0", () => {
  const p = buildProof(mainnet(), loadEvidence(), [], [], "2026-11-12T18:00:00.000Z");
  const c = proofCopy(JSON.parse(JSON.stringify(p)));
  assert.deepEqual([c.read, c.calls, c.usdg, c.wif, c.wifSub, c.escrows, c.escrowSub], [true, "4", "0.60", "140", "4 cashback · 2 to workers", "2", "0.40 USDG locked for workers"]);
  assert.equal(
    c.note,
    "Read on Robinhood Chain on 12 Nov 2026, 03:14 UTC (block 112,214,177), plus every call this server settled since 12 Nov 2026, 18:00 UTC. Up to that read, every payer was a wallet of the team.",
  );
  const unread = proofCopy(null);
  assert.equal(unread.read, false);
  for (const k of ["calls", "usdg", "wif", "escrows"] as const) assert.equal(unread[k], "—", k);
  assert.equal(unread.note, "The transactions could not be read right now.");
  const empty = proofCopy(buildProof(mainnet({ PAY_TO: Wallet.createRandom().address }), loadEvidence(), [], [], "x"));
  assert.equal(empty.calls, "—");
  assert.match(empty.note, /^Nothing on chain to show for this server yet/);
  assert.equal(plain("140.0"), "140");
  assert.equal(plain("0.0087"), "0.0087");
  assert.equal(plain("10"), "10");
  assert.equal(utcDate("2026-11-07T18:48:38Z"), "7 Nov 2026, 18:48 UTC");
  assert.equal(utcDate("not a date"), "not a date");
});

test("the page names the merchant's ERC-8004 identities the evidence records, and promises no ratings on Robinhood Chain", () => {
  const html = readFileSync("public/index.html", "utf8");
  const reg = raw.execution_market.merchant_registrations;
  assert.match(html, new RegExp(`agent ${reg.robinhood.agent_id} on Robinhood Chain and agent ${reg.base.agent_id} on Base`));
  assert.match(html, new RegExp(`/token/${raw.erc8004.identity_registry}/instance/${reg.robinhood.agent_id}"`));
  assert.match(html, /writes no ratings on Robinhood Chain yet/);
  // the swarm's count is the server's (swarmPaid), not typed in the page
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ""), /\b(six|6) (swarm |agent-to-agent )?tasks\b/i);
});
