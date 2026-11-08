// The landing page as the server ships it (src/index.ts serves ./public behind the API), and the one thing the page
// redesign must never move: an unpaid POST /api/ask still answers 402 with the USDG terms, and nothing reaches the
// facilitator. Also what the page says about escrow (public/page-state.js): it runs only when the server hires
// through Execution Market, and the static HTML says it is off. No RPC, no network: a fake chain and a facilitator
// that only counts calls.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { PAUSED_FALLBACK, escrowCopy, isAbsent, usdg, valueAt } from "../public/page-state.js";

const payTo = Wallet.createRandom().address;
const facCalls: string[] = [];
const servers: { close: () => void }[] = [];
const dirs: string[] = [];
// this file's own port range: the test files run in parallel, each in a range of its own
let nextPort = 40700 + Math.floor(Math.random() * 250);
let base = "";

const chain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: "0x00000000000000000000000000000000000000ee",
  balanceOf: async () => 0n,
  tierOf: async () => "standard",
  sendWif: async () => {
    throw new Error("no $WIF in this test");
  },
};

before(() => {
  const fac = new Hono();
  fac.all("/*", (c) => {
    facCalls.push(c.req.path);
    return c.json({ isValid: false, invalidReason: "not in this test" }, 500);
  });
  const facPort = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port: facPort }));

  const dir = mkdtempSync(path.join(tmpdir(), "flatfee-page-"));
  dirs.push(dir);
  // the live demo's shape: mainnet, $WIF cashback on, hiring on Flat Fee's own board (EM_HIRE off)
  const cfg = loadConfig({
    NETWORK: "robinhood",
    RPC_URL: "http://127.0.0.1:9",
    PAY_TO: payTo,
    FACILITATOR_URL: `http://127.0.0.1:${facPort}`,
    DATA_DIR: dir,
    WIF_CASHBACK: "10",
    WIF_WORKER_REWARD: "50",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    WORKER_TOKEN: "a-worker-token-of-16+",
  });
  // the same wiring as src/index.ts: the API first, then the static page
  const app = createApp({ cfg, chain, store: new Store(dir), log: () => {} });
  app.use("/*", serveStatic({ root: "./public" }));
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("an unpaid POST /api/ask still answers 402 with the USDG terms on Robinhood Chain, and the facilitator is never called", async () => {
  facCalls.length = 0;
  const r = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "latest block?" }),
  });
  assert.equal(r.status, 402);
  const accept = ((await r.json()) as { accepts: Record<string, any>[] }).accepts[0];
  assert.equal(accept.scheme, "exact");
  assert.equal(accept.network, "eip155:4663");
  // USDG on Robinhood Chain mainnet, written out rather than read from CHAINS, so a change there shows up here
  assert.equal(accept.asset, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(accept.amount, "100000");
  assert.equal(accept.payTo, payTo);
  assert.deepEqual(accept.extra, { name: "Global Dollar", version: "1" });
  assert.deepEqual(facCalls, []);
});

test("an unpaid POST /api/hire on the board (EM_HIRE off) still answers 402 at the hire price", async () => {
  facCalls.length = 0;
  const r = await fetch(`${base}/api/hire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: "Check that the cafe is open." }),
  });
  assert.equal(r.status, 402);
  const accept = ((await r.json()) as { accepts: Record<string, any>[] }).accepts[0];
  assert.equal(accept.scheme, "exact");
  assert.equal(accept.network, "eip155:4663");
  assert.equal(accept.asset, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(accept.amount, "500000");
  assert.equal(accept.payTo, payTo);
  assert.deepEqual(accept.extra, { name: "Global Dollar", version: "1" });
  assert.deepEqual(facCalls, []);
});

test("GET / serves the page, and every file it loads is there", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  const html = await r.text();
  assert.match(html, /<title>Flat Fee<\/title>/);
  assert.match(html, /<body data-escrow="off">/);
  const app = readFileSync("public/app.js", "utf8");
  const assets = new Set([...html.matchAll(/(?:href|src)="(\/[^"]+)"/g), ...app.matchAll(/from "(\/[^"]+)"/g)].map((m) => m[1]));
  const paths = new Set([...assets].map((a) => a.split("?")[0]));
  for (const a of ["/style.css", "/app.js", "/logo.png", "/x402-browser.js", "/page-state.js"]) assert.ok(paths.has(a), a);
  for (const a of assets) assert.equal((await fetch(`${base}${a}`)).status, 200, a);
  // the page's own stylesheet and script carry a version, so a cached copy of the old page's files is not reused
  assert.match(html, /href="\/style\.css\?v=\w+"/);
  assert.match(html, /src="\/app\.js\?v=\w+"/);
});

test("the static page promises nothing about escrow and invents no amount", () => {
  const html = readFileSync("public/index.html", "utf8");
  const text = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  // escrow is described (how it works), never said to run now, to hold the buyer's money, or to come soon
  assert.doesNotMatch(text, /\blive\b|\bheld\b|\bsoon\b|\bwill\b|your (fee|payment|money|usdg)[^.]*escrow|escrow[^.]*your (fee|payment|money|usdg)/i);
  // every amount waits for /api/info, and every line that needs a value is hidden until it arrives
  const amounts = [...html.matchAll(/<[^>]*data-(?:usdg|info)="(prices\.[^"]*|wif\.[^"]*)"[^>]*>([^<]*)</g)];
  assert.ok(amounts.length >= 10);
  for (const [, path, shown] of amounts) assert.equal(shown, "…", path);
  assert.equal(staticText(html, "escrow-bounty-amount"), "…");
  const needs = [...html.matchAll(/<[^>]*data-needs="[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.ok(needs.length >= 6);
  for (const tag of needs) assert.match(tag, /\shidden(\s|>)/, tag);
});

test("app.js applies the server's escrow state and sends the same requests as before", () => {
  const app = readFileSync("public/app.js", "utf8");
  const html = readFileSync("public/index.html", "utf8");
  // the escrow wording comes from /api/info, never from a fixed object
  assert.match(app, /const copy = escrowCopy\(info\);/);
  assert.match(app, /document\.body\.dataset\.escrow = copy\.escrow;/);
  for (const k of ["pill", "statusLabel", "statusText", "foot", "boardMeta", "boardHow"]) assert.match(app, new RegExp(`= copy\\.${k};`), k);
  // the payment: the payer hint before the 402, then the signed X-PAYMENT, built by the shared x402-browser.js
  assert.match(app, /"x-payer": from/);
  assert.match(app, /"X-PAYMENT": paymentHeader\(accept, typed, signature\)/);
  assert.match(app, /typedDataFor\(accept, from\)/);
  // the bodies: the field names /api/ask, /api/hire and the board read
  assert.match(app, /payAndCall\("\/api\/ask", \{ question: \$\("#question"\)\.value \}/);
  assert.match(app, /payAndCall\("\/api\/hire", \{ request: \$\("#request"\)\.value \}/);
  assert.match(app, /body: JSON\.stringify\(\{ question: \$\("#question"\)\.value \}\)/);
  assert.match(app, /body: JSON\.stringify\(\{ worker: \$\("#worker"\)\.value\.trim\(\), \.\.\.extra \}\)/);
  assert.match(app, /taskAction\(t\.id, "complete", \{ answer: input\.value \}\)/);
  // the worker token travels only in its header, typed into a password field
  assert.match(app, /"x-worker-token": \$\("#worker-token"\)\.value/);
  assert.match(html, /<input id="worker-token" type="password"/);
});

test("the page calls only API routes the server has", async () => {
  const app = readFileSync("public/app.js", "utf8");
  const used = [...new Set([...app.matchAll(/"(\/api\/[a-z/]+)"/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ["/api/ask", "/api/hire", "/api/info", "/api/ledger", "/api/tasks"]);
  for (const p of ["/api/info", "/api/ledger", "/api/tasks"]) assert.equal((await fetch(`${base}${p}`)).status, 200, p);
  // the board actions the page posts to (claim / complete) are there, and closed without the worker token
  assert.match(app, /`\/api\/tasks\/\$\{id\}\/\$\{action\}`/);
  for (const action of ["claim", "complete"]) {
    const r = await fetch(`${base}/api/tasks/1/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401, action);
  }
});

// the escrow-off strings exactly as index.html ships them, before app.js runs
function staticText(html: string, id: string): string {
  const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
  assert.ok(m, `no #${id} in index.html`);
  return m[1];
}

test("the static page says escrow is off, in the very words page-state.js uses for a board server", () => {
  const html = readFileSync("public/index.html", "utf8");
  const off = escrowCopy({ hire: { via: "board" } });
  assert.equal(off.escrow, "off");
  assert.equal(staticText(html, "escrow-pill"), off.pill);
  assert.equal(staticText(html, "hire-status-label"), off.statusLabel);
  assert.equal(staticText(html, "hire-status-text"), off.statusText);
  assert.equal(staticText(html, "escrow-foot"), off.foot);
  assert.equal(staticText(html, "board-meta"), off.boardMeta);
  assert.equal(staticText(html, "board-how"), off.boardHow);
  // the worker's escrowed amount only shows once escrow runs
  assert.match(html, /<span id="escrow-bounty" hidden>/);
});

test("the escrow wording, word for word: a change to it is a change to this test", () => {
  // the off state as the live demo shows it; no date, no promise, nothing about the buyer's fee in escrow
  assert.deepEqual(escrowCopy({ hire: { via: "board" } }), {
    escrow: "off",
    pill: "Off on this demo",
    statusLabel: "Today, without escrow:",
    statusText: "your task goes on the task board below, for a person to answer.",
    bounty: null,
    foot: "Waiting for Execution Market's escrow on Robinhood Chain.",
    boardMeta: "for workers: claim and answer",
    boardHow: "Workers: enter your wallet and worker token, claim a task, send the answer.",
    expiry: null,
  });
  // the server says what becomes of a hire nobody finishes (src/emhire.ts hireExpiry); the page repeats it as sent
  const expiry = "If no one takes it within 72 h, it expires.";
  assert.deepEqual(escrowCopy({ network: { label: "Robinhood Chain" }, hire: { via: "execution-market", bounty: "0.125", deadlineHours: 72, available: true, paused: null, expiry } }), {
    escrow: "on",
    pill: "Live on this demo",
    statusLabel: "With escrow:",
    statusText: "your task goes to Execution Market, and answers show on the task board below.",
    bounty: "0.125",
    foot: "Escrow on Robinhood Chain. Deadline 72 h.",
    boardMeta: "tasks on Execution Market",
    boardHow: "Tasks hired through Execution Market, and where each one stands. People take them on Execution Market.",
    expiry,
  });
  // paused: the server's sentence, as it sent it
  const reason = "The wallet that pays the escrow cannot fund one more task right now.";
  assert.deepEqual(escrowCopy({ network: { label: "Robinhood Chain" }, hire: { via: "execution-market", bounty: "0.125", deadlineHours: 72, available: false, paused: { kind: "funds", reason }, expiry } }), {
    escrow: "paused",
    pill: "Paused on this demo",
    statusLabel: "Hiring is paused:",
    statusText: reason,
    bounty: "0.125",
    foot: "Escrow on Robinhood Chain. Deadline 72 h.",
    boardMeta: "tasks on Execution Market",
    boardHow: "Tasks hired through Execution Market, and where each one stands. People take them on Execution Market.",
    expiry,
  });
  // no expiry from the server, or not a string: nothing is said
  for (const bad of [undefined, null, "", "  ", 42, ["x"]]) assert.equal(escrowCopy({ hire: { via: "execution-market", available: true, expiry: bad } }).expiry, null, String(bad));
  // the first screen's fixed text: headline, subtitle, button, the line under it, and the four steps
  const html = readFileSync("public/index.html", "utf8");
  const text = (re: RegExp) => {
    const m = re.exec(html);
    assert.ok(m, String(re));
    return m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  };
  assert.equal(text(/<h1 id="h">([\s\S]*?)<\/h1>/), "Hire a human for a small task.");
  assert.equal(text(/<p class="sub">([\s\S]*?)<\/p>/), "One flat fee in USDG. No account, no card.");
  assert.equal(text(/<button class="pay" id="hire-pay" type="button">([\s\S]*?)<\/button>/), "Pay … USDG and hire");
  assert.equal(text(/<p class="meta">([\s\S]*?)<\/p>/), "No gas, no refunds · $WIF holders (…+) pay …");
  assert.equal(text(/<h2 id="how">([\s\S]*?)<\/h2>/), "How hiring with escrow works");
  const steps = [...text(/<ol class="steps">([\s\S]*?)<\/ol>/).matchAll(/[^.]+\./g)].map((m) => m[0].trim());
  assert.deepEqual(steps, [
    "You pay the flat fee up front.",
    "A person takes it on Execution Market.",
    "The worker's pay is locked in escrow: … USDG.",
    "Flat Fee approves the answer; escrow releases their pay.",
  ]);
});

test("this server (EM_HIRE off, the live demo's shape) makes the page say escrow is off", async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.deepEqual(info.hire, { via: "board" });
  assert.equal(escrowCopy(info).escrow, "off");
});

test("escrow is said to run only for hire.via exactly \"execution-market\"", () => {
  const notOn = [undefined, null, {}, { hire: null }, { hire: {} }, { hire: { via: "board" } }, { hire: { via: "Execution-Market" } },
    { hire: { via: " execution-market" } }, { hire: { via: "execution-market " } }, { hire: { via: "execution market" } }, { hire: "execution-market" }];
  for (const info of notOn) {
    const c = escrowCopy(info);
    assert.equal(c.escrow, "off", JSON.stringify(info));
    assert.equal(c.bounty, null, JSON.stringify(info));
    // nothing in the off state says escrow runs now, or that the task goes to Execution Market
    for (const s of Object.values(c).filter((v): v is string => typeof v === "string")) {
      assert.doesNotMatch(s, /\blive\b|\blocked\b|goes to Execution Market|\bwith escrow:/i, s);
    }
  }
  const on = escrowCopy({ network: { label: "Robinhood Chain" }, hire: { via: "execution-market", bounty: "0.125", deadlineHours: 72, available: true } });
  assert.equal(on.escrow, "on");
  assert.equal(on.pill, "Live on this demo");
  assert.equal(on.statusLabel, "With escrow:");
  assert.equal(on.bounty, "0.125");
  assert.equal(on.foot, "Escrow on Robinhood Chain. Deadline 72 h.");
  assert.equal(on.boardMeta, "tasks on Execution Market");
  // without a bounty or a deadline, neither is made up
  const bare = escrowCopy({ network: { label: "Robinhood Chain Testnet" }, hire: { via: "execution-market", bounty: "0", available: true } });
  assert.equal(bare.bounty, null);
  assert.equal(bare.foot, "Escrow on Robinhood Chain Testnet.");
});

test("through Execution Market, the page says Live only when the server says a hire would be taken now; otherwise paused, never with a made-up cause", () => {
  const hire = { via: "execution-market", bounty: "0.2", deadlineHours: 24 };
  // anything but available exactly true is paused: missing (an older server), false, a string, a number
  for (const available of [undefined, null, false, "true", 1, "yes"]) {
    const c = escrowCopy({ network: { label: "Robinhood Chain" }, hire: { ...hire, available } });
    assert.equal(c.escrow, "paused", String(available));
    assert.equal(c.pill, "Paused on this demo", String(available));
    // no reason from the server: a fixed sentence that names no cause
    assert.equal(c.statusText, PAUSED_FALLBACK, String(available));
    for (const s of Object.values(c).filter((v): v is string => typeof v === "string")) {
      assert.doesNotMatch(s, /\blive\b|goes to Execution Market|\bwith escrow:/i, s);
    }
  }
  // the reason is shown as the server sent it; an empty or non-string one falls back
  const withReason = (paused: unknown) => escrowCopy({ hire: { ...hire, available: false, paused } }).statusText;
  assert.equal(withReason({ kind: "escrow", reason: "Execution Market's escrow on Robinhood Chain cannot take a hire right now." }), "Execution Market's escrow on Robinhood Chain cannot take a hire right now.");
  for (const bad of [null, {}, { reason: "" }, { reason: "   " }, { reason: 42 }, { reason: ["x"] }, "a string"]) assert.equal(withReason(bad), PAUSED_FALLBACK, JSON.stringify(bad));
  // available: true wins over a stale paused object; it is the server's word on now
  assert.equal(escrowCopy({ hire: { ...hire, available: true, paused: { reason: "old" } } }).escrow, "on");
  assert.equal(PAUSED_FALLBACK, "this server is not taking hires right now.");
});

test("USDG amounts keep every decimal the server sends, and show at least two", () => {
  assert.equal(usdg("0.5"), "0.50");
  assert.equal(usdg("0.05"), "0.05");
  assert.equal(usdg("0.10"), "0.10");
  assert.equal(usdg("0.125"), "0.125");
  assert.equal(usdg("1"), "1.00");
  assert.equal(usdg("0.100000"), "0.10");
});

test("a missing value or an amount of zero is not mentioned; anything else is", () => {
  for (const v of [undefined, null, "", "0", "0.0", "0.00", "00"]) assert.equal(isAbsent(v), true, String(v));
  for (const v of ["10", "0.05", "50", "0x5173b8ea6923c2d40267890d45c46a3480954773", "100"]) assert.equal(isAbsent(v), false, v);
  const info = { wif: { token: null, cashback: "0", workerReward: "50" }, prices: { hire: { standard: "0.5" } } };
  assert.equal(valueAt(info, "prices.hire.standard"), "0.5");
  assert.equal(valueAt(info, "prices.ask.standard"), undefined);
  assert.equal(valueAt(info, "wif.token.deeper"), undefined);
  assert.equal(isAbsent(valueAt(info, "wif.token")), true);
  assert.equal(isAbsent(valueAt(info, "wif.cashback")), true);
  assert.equal(isAbsent(valueAt(info, "wif.workerReward")), false);
});

test("a long word in a task or an answer wraps on a phone instead of widening the page", () => {
  // a request or an answer is up to 500 characters from whoever pays or answers, maybe one long URL with no space
  const css = readFileSync("public/style.css", "utf8");
  for (const sel of [".tasks .q", ".tasks .answer", ".tasks .tm"]) {
    const rule = css.split("\n").find((l) => l.startsWith(`${sel} {`));
    assert.ok(rule, sel);
    assert.match(rule, /overflow-wrap: anywhere;/, sel);
  }
});
