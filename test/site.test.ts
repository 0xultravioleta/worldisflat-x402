// What the server renders itself (src/site.ts), read as a reader with no JavaScript reads it: the landing page with the
// real values in it, /proof, /llms.txt, /skill.md and /.well-known/x402. Every value must be the one the API serves:
// the 402s are this server's own, the figures GET /api/proof's, the amounts GET /api/info's. No RPC, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { newEmState, type EmHire } from "../src/emhire.js";
import { EVIDENCE_FILES } from "../src/proof.js";
import { skillMd } from "../src/site.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { flowCopy, utcDate } from "../public/page-state.js";
// @ts-expect-error plain JS module shared with the browser
import { typedDataFor } from "../public/x402-browser.js";
import { FakeDocument, visibleText } from "./fake-dom.js";

const MERCHANT = "0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6";
// Execution Market's contracts on Robinhood Chain, as the live demo's deploy sets them (one source: deploy/aws/em-hire.env)
const EM_ENV = Object.fromEntries(
  readFileSync("deploy/aws/em-hire.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^EM_[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const PUBLIC = "https://flatfee.example";
const servers: { close: () => void }[] = [];
const dirs: string[] = [];
// this file's own port range: the test files run in parallel, each in a range of its own
let nextPort = 41700 + Math.floor(Math.random() * 250);
let live = ""; // the live demo's shape: mainnet, the real merchant, EM on and taking hires, $WIF on, PUBLIC_URL set
let paused = ""; // the same with hiring paused
let board = ""; // the task board (EM off), testnet, no $WIF

const chain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: MERCHANT,
  balanceOf: async () => 0n,
  tierOf: async () => "standard",
  sendWif: async () => {
    throw new Error("no $WIF in this test");
  },
};
const emHire: EmHire = { unavailable: () => null, refuses: () => null, refresh: async () => {}, publish: async () => { throw new Error("no publish"); }, tick: async () => {}, start: () => () => {} };

function start(env: Record<string, string>, deps: { emHire?: EmHire } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-site-"));
  dirs.push(dir);
  const app = createApp({ cfg: loadConfig({ RPC_URL: "http://127.0.0.1:9", DATA_DIR: dir, ...env }), chain, store: new Store(dir), log: () => {}, ...deps });
  app.use("/*", serveStatic({ root: "./public" }));
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  return `http://127.0.0.1:${port}`;
}

before(() => {
  const liveEnv = {
    NETWORK: "robinhood",
    PAY_TO: MERCHANT,
    PUBLIC_URL: PUBLIC,
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    WORKER_TOKEN: "a-worker-token-of-16+",
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    EM_ESCROW_ADDRESS: EM_ENV.EM_ESCROW_ADDRESS,
    EM_OPERATOR_ADDRESS: EM_ENV.EM_OPERATOR_ADDRESS,
    EM_TOKEN_COLLECTOR_ADDRESS: EM_ENV.EM_TOKEN_COLLECTOR_ADDRESS,
    EM_BOUNTY_USDG: "0.20",
    EM_DEADLINE_HOURS: "24",
  };
  live = start(liveEnv, { emHire });
  paused = start(liveEnv, { emHire: { ...emHire, unavailable: () => ({ kind: "funds", detail: "the merchant cannot fund one more escrow" }) } });
  board = start({ NETWORK: "robinhood-testnet", PAY_TO: Wallet.createRandom().address, WORKER_TOKEN: "a-worker-token-of-16+" });
});

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const get = async (base: string, p: string) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, type: r.headers.get("content-type") ?? "", text: await r.text() };
};
const json = async (base: string, p: string) => (await fetch(`${base}${p}`)).json();
const unpaid402 = async (base: string, route: "ask" | "hire") => {
  const body = route === "ask" ? { question: "What is the latest block?" } : { request: "Check that the cafe on 5th street is open and reply in text with today's hours." };
  const r = await fetch(`${base}/api/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test("with no JavaScript, GET / carries the real prices, the escrow state, the four figures and the cards: no '…' and no 'Off on this demo'", async () => {
  const r = await get(live, "/");
  assert.equal(r.status, 200);
  const html = r.text;
  const info = await json(live, "/api/info");
  const proof = await json(live, "/api/proof");
  assert.equal(info.hire.via, "execution-market");
  // nothing waits for a script
  assert.equal([...html.matchAll(/>…</g)].length, 0, "no '…' left as a value");
  assert.ok(!html.includes("Off on this demo"));
  assert.match(html, /<body data-escrow="on">/);
  assert.match(html, /id="escrow-pill">Live on this demo</);
  // every price, as /api/info says it
  for (const [p, v] of [["prices.ask.standard", "0.10"], ["prices.ask.holder", "0.05"], ["prices.hire.standard", "0.50"], ["prices.hire.holder", "0.25"]]) {
    assert.match(html, new RegExp(`data-usdg="${p.replace(/\./g, "\\.")}">${v.replace(".", "\\.")}<`), p);
  }
  // the four figures, as /api/proof says them
  const n = (id: string) => new RegExp(`id="${id}"[^>]*><span class="n">([^<]*)<`).exec(html)?.[1];
  assert.deepEqual([n("stat-calls"), n("stat-usdg"), n("stat-wif"), n("stat-escrow")], [String(proof.paidCalls.count), "0.60", "140", String(proof.escrows.count)]);
  // the $WIF lines are shown, the bounty and the expiry too
  assert.doesNotMatch(html, /data-needs="wif\.[a-zA-Z]+" hidden/);
  assert.match(html, /<span id="escrow-bounty">: <span id="escrow-bounty-amount">0\.20<\/span> USDG<\/span>/);
  assert.match(html, new RegExp(`id="escrow-expiry">${info.hire.expiry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;")}<`));
  // every transaction and every card is in the markup, each tx linked in full
  for (const t of [...proof.paidCalls.txs, ...proof.wif.txs, ...proof.escrows.txs]) assert.ok(html.includes(`href="${t.url}"`), t.tx);
  assert.equal([...html.matchAll(/<li class="job">/g)].length, proof.work.length);
  // read as a person with no script: no "…" standing for a value (a shortened hash, 0x1234…abcd, is not one)
  const doc = new FakeDocument(html);
  assert.doesNotMatch(visibleText(doc.body), /(?<![0-9a-fA-F])…(?![0-9a-fA-F])/, "no '…' in the visible text");
  assert.equal(visibleText(doc.querySelector("[data-origin]")), PUBLIC);
});

test("the money flow and its fees come from /api/info and from a real escrow payment: 0.50 paid, 0.20 escrowed, 0.174 to the worker, 13% to Execution Market", async () => {
  const info = await json(live, "/api/info");
  const proof = await json(live, "/api/proof");
  // Execution Market's cut, measured on the newest of Flat Fee's hires in the dated read
  const ev = JSON.parse(readFileSync(EVIDENCE_FILES[0], "utf8"));
  const mine = ev.execution_market.tasks.filter((t: { agent_id: string }) => t.agent_id.toLowerCase() === MERCHANT.toLowerCase());
  const newest = mine.sort((a: { payment_tx: { at: string } }, b: { payment_tx: { at: string } }) => (a.payment_tx.at < b.payment_tx.at ? 1 : -1))[0];
  assert.equal(proof.emFee.tx, newest.payment_tx.tx);
  assert.equal(proof.emFee.bps, 1300);
  const f = flowCopy(info, proof);
  assert.deepEqual(
    { pay: f.pay, payHolder: f.payHolder, bounty: f.bounty, keep: f.keep, keepHolder: f.keepHolder, worker: f.worker, fee: f.fee, feeAmount: f.feeAmount, reward: f.reward },
    { pay: "0.50", payHolder: "0.25", bounty: "0.20", keep: "0.30", keepHolder: "0.05", worker: "0.174", fee: "13%", feeAmount: "0.026", reward: "50" },
  );
  // the worker's 0.174 is what the payment transaction paid: the page says nothing the chain does not
  assert.ok(newest.payment_tx.transfers.some((t: { amount: string }) => t.amount === "0.174"));
  const html = (await get(live, "/")).text;
  assert.match(html, /id="flow" aria-labelledby="flow-h">/);
  for (const [k, v] of [["pay", "0.50"], ["bounty", "0.20"], ["keep", "0.30"], ["worker", "0.174"], ["fee", "13%"], ["feeAmount", "0.026"]]) assert.match(html, new RegExp(`id="flow-${k}">${v.replace(".", "\\.")}<`), k);
  assert.match(html, new RegExp(`id="flow-fee-tx" href="${proof.emFee.url}"`));
  // no flow on a server that does not hire through Execution Market, and none made up without a measured fee
  assert.equal(flowCopy(await json(board, "/api/info"), await json(board, "/api/proof")), null);
  assert.equal(flowCopy(info, { ...proof, emFee: null }), null);
  assert.match((await get(board, "/")).text, /id="flow" aria-labelledby="flow-h" hidden>/);
});

test("'What Flat Fee cannot do with your money' says only what the 402 and the signing code do: one exact amount, to the merchant, valid 5 minutes", async () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /signs one EIP-3009 authorization for the exact price, to Flat Fee's wallet, valid for 5 minutes\./);
  const { status, body } = await unpaid402(live, "ask");
  assert.equal(status, 402);
  const accept = body.accepts[0];
  assert.equal(accept.maxTimeoutSeconds, 300);
  assert.equal(accept.payTo, MERCHANT);
  const typed = typedDataFor(accept, Wallet.createRandom().address, { now: 1000 });
  assert.equal(typed.message.validBefore, "1300");
  assert.equal(typed.message.value, accept.amount);
  assert.equal(typed.message.to, MERCHANT);
});

test("with hiring paused, the page with no JavaScript says paused, in the server's words, never Live", async () => {
  const html = (await get(paused, "/")).text;
  assert.match(html, /<body data-escrow="paused">/);
  assert.match(html, /id="escrow-pill">Paused on this demo</);
  assert.ok(!html.includes("Live on this demo"));
  // the task board server renders its own state: escrow off, the board's words
  const b = (await get(board, "/")).text;
  assert.match(b, /<body data-escrow="off">/);
  assert.match(b, /id="escrow-pill">Off on this demo</);
});

test("GET /proof lists every contract and wallet, every transaction with its block, and how to check one by RPC", async () => {
  const r = await get(live, "/proof");
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  const proof = await json(live, "/api/proof");
  const info = await json(live, "/api/info");
  for (const a of [info.usdg, info.wif.token, MERCHANT, proof.facilitator, EM_ENV.EM_ESCROW_ADDRESS, EM_ENV.EM_OPERATOR_ADDRESS, EM_ENV.EM_TOKEN_COLLECTOR_ADDRESS, proof.identity.registry]) {
    assert.match(a, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(r.text.includes(`/address/${a}"`), a);
  }
  for (const t of [...proof.paidCalls.txs, ...proof.wif.txs]) {
    assert.ok(r.text.includes(`href="${t.url}"`), t.tx);
    assert.ok(r.text.includes(Number(t.block).toLocaleString("en-US")), `block of ${t.tx}`);
  }
  for (const w of proof.work) for (const u of [w.escrowUrl, w.paymentUrl, w.page].filter(Boolean)) assert.ok(r.text.includes(`href="${u}"`), u);
  assert.match(r.text, /eth_getTransactionReceipt/);
  assert.ok(r.text.includes("https://rpc.mainnet.chain.robinhood.com"));
  assert.ok(r.text.includes(proof.paidCalls.txs[0].tx));
  assert.equal([...r.text.matchAll(/>…</g)].length, 0);
  assert.match(r.text, /no ratings are written on Robinhood Chain yet/);
});

test("GET /llms.txt and GET /skill.md give an agent this server's prices and its real 402, word for word", async () => {
  const llms = await get(live, "/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(llms.type, /text\/plain/);
  for (const p of ["/skill.md", "/.well-known/x402", "/proof", "/api/info", "/api/proof"]) assert.ok(llms.text.includes(`${PUBLIC}${p}`), p);
  assert.match(llms.text, /POST https:\/\/flatfee\.example\/api\/ask with \{"question": "\.\.\."\}: .* 0\.10 USDG \(0\.05 for a wallet holding 100\+ \$WIF/);
  const skill = await get(live, "/skill.md");
  assert.equal(skill.status, 200);
  assert.match(skill.type, /text\/markdown/);
  const ask = await unpaid402(live, "ask");
  assert.ok(skill.text.includes(JSON.stringify(ask.body, null, 2)), "the real 402 of POST /api/ask");
  assert.ok(skill.text.includes(`"resource": "${PUBLIC}/api/ask"`));
  assert.match(skill.text, /verifyingContract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"/);
  // without PUBLIC_URL, the example 402 names the origin the agent asked
  assert.ok((await get(board, "/skill.md")).text.includes(`"resource": "${board}/api/ask"`));
  // a paused hire is not offered as payable: the skill says what the server answers
  assert.match((await get(paused, "/skill.md")).text, /Right now it answers 503: hiring is paused/);
});

test("GET /.well-known/x402 lists the payable resources with this server's own accepts, and the service as Execution Market publishes its own", async () => {
  const d = await json(live, "/.well-known/x402");
  const ask = await unpaid402(live, "ask");
  const hire = await unpaid402(live, "hire");
  assert.deepEqual(d.resources.map((r: { url: string }) => r.url), [`${PUBLIC}/api/ask`, `${PUBLIC}/api/hire`]);
  assert.deepEqual(d.resources[0].accepts, ask.body.accepts);
  assert.deepEqual(d.resources[1].accepts, hire.body.accepts);
  for (const r of d.resources) assert.deepEqual([r.type, r.x402Version], ["http", 2]);
  assert.equal(d.x402.provider.url, PUBLIC);
  assert.equal(d.x402.identity.agentId, 22487);
  assert.equal(d.x402.networks[0].chainId, 4663);
  assert.equal(d.x402.endpoints.ask.pricing.standard, "0.1");
  // paused: the hire answers 503, so it is not listed as payable
  const p = await json(paused, "/.well-known/x402");
  assert.deepEqual(p.resources.map((r: { url: string }) => r.url), [`${PUBLIC}/api/ask`]);
  // nothing in these entries reached the facilitator or the chain: they are the unpaid 402s
  assert.equal((await json(live, "/api/proof")).paidCalls.count, 4);
});

test("a buyer's text and a worker's answer reach the server-rendered page as text, never as markup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-site-xss-"));
  dirs.push(dir);
  const store = new Store(dir);
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
  const t = store.createTask({ request: evil, payer: Wallet.createRandom().address, paidTx: `0x${"ab".repeat(32)}` });
  store.updateTask(t.id, { status: "done", answer: evil, worker: Wallet.createRandom().address });
  const app = createApp({ cfg: loadConfig({ RPC_URL: "http://127.0.0.1:9", DATA_DIR: dir, NETWORK: "robinhood-testnet", PAY_TO: Wallet.createRandom().address, WORKER_TOKEN: "a-worker-token-of-16+" }), chain, store, log: () => {} });
  const html = await (await app.request("/")).text();
  assert.ok(!html.includes("<script>alert(1)"), "no script from a task");
  assert.ok(!html.includes("<img src=x"), "no markup from a task");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;"));
  // the escaped text reads back as the buyer wrote it
  const doc = new FakeDocument(html);
  assert.ok(visibleText(doc.querySelector("#tasks")).includes(evil));
});

test("a paid-out hire's card on the server-rendered page shows the buyer's request as text, never as markup", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-site-card-"));
  dirs.push(dir);
  const store = new Store(dir);
  const evil = `<script>alert(3)</script><b onclick=x>"'&`;
  const em = { ...newEmState(new Date("2026-11-13T12:00:00Z")), step: "completed" as const, taskId: "cafecafe-0000-4000-8000-000000000000", escrowTx: `0x${"c1".repeat(32)}`, paymentTx: `0x${"c2".repeat(32)}` };
  store.createTask({ request: evil, payer: Wallet.createRandom().address, paidTx: `0x${"c0".repeat(32)}`, via: "em", em });
  const cfg = loadConfig({
    RPC_URL: "http://127.0.0.1:9",
    DATA_DIR: dir,
    NETWORK: "robinhood",
    PAY_TO: MERCHANT,
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    EM_ESCROW_ADDRESS: EM_ENV.EM_ESCROW_ADDRESS,
    EM_OPERATOR_ADDRESS: EM_ENV.EM_OPERATOR_ADDRESS,
    EM_TOKEN_COLLECTOR_ADDRESS: EM_ENV.EM_TOKEN_COLLECTOR_ADDRESS,
    EM_BOUNTY_USDG: "0.20",
  });
  const app = createApp({ cfg, chain, store, log: () => {}, emHire });
  const html = await (await app.request("/")).text();
  const work = /<ul class="work" id="work">([\s\S]*?)<\/ul>/.exec(html)![1];
  assert.match(work, /#cafecafe/, "the card is there");
  assert.ok(!work.includes("<script>alert(3)"), "no script in the card");
  assert.ok(!work.includes("<b onclick"), "no markup in the card");
  assert.ok(work.includes("&lt;script&gt;alert(3)&lt;/script&gt;&lt;b onclick=x&gt;&quot;&#39;&amp;"));
  assert.ok(visibleText(new FakeDocument(html).querySelector("#work")).includes(evil));
});

test("GET /proof names where the locked USDG sits: the escrow's token store, the address every recorded lock pays into and every payment comes from", async () => {
  const proof = await json(live, "/api/proof");
  const store = proof.escrowTokenStore.toLowerCase();
  const read = JSON.parse(readFileSync(EVIDENCE_FILES[2], "utf8")).escrow_token_store;
  assert.equal(read.escrow, EM_ENV.EM_ESCROW_ADDRESS);
  assert.equal(read.operator, EM_ENV.EM_OPERATOR_ADDRESS);
  // the chain data the page already shows agrees: each lock moves USDG from the token collector into it, each payment
  // out of escrow moves USDG out of it
  const tasks = [JSON.parse(readFileSync(EVIDENCE_FILES[0], "utf8")), JSON.parse(readFileSync(EVIDENCE_FILES[1], "utf8"))].flatMap((d) => d.execution_market.tasks);
  let locks = 0;
  let payments = 0;
  for (const t of tasks) {
    if (t.escrow_tx) {
      assert.ok(t.escrow_tx.transfers.some((x: { from: string; to: string }) => x.from.toLowerCase() === EM_ENV.EM_TOKEN_COLLECTOR_ADDRESS.toLowerCase() && x.to.toLowerCase() === store), t.escrow_tx.tx);
      locks++;
    }
    if (t.payment_tx) {
      assert.ok(t.payment_tx.transfers.every((x: { from: string }) => x.from.toLowerCase() === store), t.payment_tx.tx);
      payments++;
    }
  }
  assert.ok(locks >= 7 && payments >= 8);
  const page = (await get(live, "/proof")).text;
  assert.ok(page.includes(`/address/${proof.escrowTokenStore}"`));
  assert.match(page, /Execution Market&#39;s escrow token store/);
  // each lock and each payment with its date and its block
  for (const w of proof.work) {
    if (w.escrowAt) assert.ok(page.includes(`${utcDate(w.escrowAt)} · block ${Number(w.escrowBlock).toLocaleString("en-US")}`), `lock of #${w.ref}`);
    if (w.paymentAt) assert.ok(page.includes(`${utcDate(w.paymentAt)} · block ${Number(w.paymentBlock).toLocaleString("en-US")}`), `payment of #${w.ref}`);
  }
  // newest first in every table, and the RPC example checks the newest paid call
  const order = (txs: { url: string }[]) => txs.map((t) => page.indexOf(`href="${t.url}"`));
  for (const list of [proof.paidCalls.txs, proof.wif.txs.filter((t: { kind: string }) => t.kind === "cashback")]) {
    const pos = order(list);
    assert.deepEqual(pos, [...pos].sort((x, y) => x - y));
    assert.deepEqual(list.map((t: { at: string }) => t.at), list.map((t: { at: string }) => t.at).sort().reverse());
  }
  assert.ok(page.includes(`"params":["${proof.paidCalls.txs[0].tx}"]`));
});

test("skill.md names everything npm run buy reads, and its validBefore is the 402's own window", async () => {
  const skill = (await get(live, "/skill.md")).text;
  for (const v of [`FLATFEE_URL=${PUBLIC}`, "PAYER_PRIVATE_KEY", "RPC_URL", "NETWORK=robinhood", `PAY_TO=${MERCHANT}`, "CONFIRM_MAINNET_SPEND"]) assert.ok(skill.includes(v), v);
  // the names are the ones the script reads
  const buy = readFileSync("scripts/buy.ts", "utf8") + readFileSync("scripts/lib/env.ts", "utf8");
  for (const v of ["FLATFEE_URL", "PAYER_PRIVATE_KEY", "CONFIRM_MAINNET_SPEND", "PAY_TO"]) assert.ok(buy.includes(v), v);
  const ask = await unpaid402(live, "ask");
  assert.ok(skill.includes(`validBefore: <now + ${ask.body.accepts[0].maxTimeoutSeconds}>`));
  // the window is read from the 402, not assumed: a 402 with another window gives another validBefore
  const ctx = { cfg: loadConfig({ RPC_URL: "http://127.0.0.1:9", NETWORK: "robinhood", PAY_TO: MERCHANT, DATA_DIR: tmpdir() }), info: await json(live, "/api/info"), proof: await json(live, "/api/proof"), ledger: [], tasks: [], origin: PUBLIC };
  const other = { status: 402, body: { ...ask.body, accepts: [{ ...ask.body.accepts[0], maxTimeoutSeconds: 120 }] } };
  assert.ok(skillMd(ctx, other, other).includes("validBefore: <now + 120>"));
});

test("the page links the agent entries and /proof, and every one answers", async () => {
  const html = readFileSync("public/index.html", "utf8");
  for (const p of ["/proof", "/llms.txt", "/skill.md", "/.well-known/x402"]) {
    assert.ok(html.includes(`href="${p}"`), p);
    assert.equal((await get(live, p)).status, 200, p);
  }
});
