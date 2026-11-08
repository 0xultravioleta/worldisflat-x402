// The landing page's script, run: public/app.js against the HTML and the /api routes the server ships (src/app.ts with
// a fake chain and a facilitator that only counts calls), in the small DOM of test/fake-dom.ts. What the page shows must
// be what this server sends: every amount, the network, the escrow's bounty and deadline, the lines that need a value,
// the amount the wallet is asked to sign and the paid calls' prices. The values are unusual on purpose (12345.125 USDG,
// 720 h, Robinhood Chain Testnet), so a constant in app.js cannot pass for the server's value. No RPC, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { Wallet, type JsonRpcProvider } from "ethers";
import { createApp } from "../src/app.js";
import type { Chain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { hireExpiry, type EmHire } from "../src/emhire.js";
import { Store } from "../src/store.js";
// @ts-expect-error plain JS module shared with the browser
import { walletPayBlocked } from "../public/x402-browser.js";
import { FakeDocument, visibleText, type FakeElement } from "./fake-dom.js";

const payTo = Wallet.createRandom().address;
const buyer = Wallet.createRandom().address;
const facCalls: string[] = [];
const servers: { close: () => void }[] = [];
const dirs: string[] = [];
// this file's own port range: the test files run in parallel, each in a range of its own
let nextPort = 41000 + Math.floor(Math.random() * 250);
let facilitatorHost = "";
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// every payer holds $WIF here: a 402 then asks the holder price, not the standard price the page lists
const holderChain: Chain = {
  provider: {} as JsonRpcProvider,
  merchantAddress: "0x00000000000000000000000000000000000000ee",
  balanceOf: async () => 0n,
  tierOf: async () => "holder",
  sendWif: async () => {
    throw new Error("no $WIF in this test");
  },
};
const standardChain: Chain = { ...holderChain, tierOf: async () => "standard" };

// EM_HIRE=on needs its driver; nothing here gets as far as publishing a task
const emHire: EmHire = {
  unavailable: () => null,
  refuses: () => null,
  refresh: async () => {},
  publish: async () => {
    throw new Error("no publish in this test");
  },
  tick: async () => {},
  start: () => () => {},
};

// EM_HIRE=on with hiring paused: the merchant cannot fund the next escrow. The detail (the 503's) names a wallet and an
// amount; the page must show only the fixed sentence /api/info sends
const PAUSE_DETAIL = "the merchant wallet 0x00000000000000000000000000000000000000ee cannot fund one more escrow (0.25 USDG needed for the open hires)";
const pausedHire: EmHire = { ...emHire, unavailable: () => ({ kind: "funds", detail: PAUSE_DETAIL }) };

let on = ""; // escrow on (EM_HIRE=on), $WIF on, every amount unusual
let paused = ""; // the same, with hiring paused (the merchant cannot fund one more escrow)
let off = ""; // the task board (EM_HIRE off), no $WIF token
let fork = ""; // the same as `off`, served as a local fork (npm run demo)
let claimedTask = "";

function start(env: Record<string, string>, deps: { chain: Chain; store: Store; localFork?: boolean; emHire?: EmHire }) {
  // the same wiring as src/index.ts: the API first, then the static page
  const app = createApp({ cfg: loadConfig({ RPC_URL: "http://127.0.0.1:9", ...env }), log: () => {}, ...deps });
  app.use("/*", serveStatic({ root: "./public" }));
  const port = nextPort++;
  servers.push(serve({ fetch: app.fetch, port }));
  return `http://127.0.0.1:${port}`;
}

before(() => {
  const fac = new Hono();
  fac.all("/*", (c) => {
    facCalls.push(c.req.path);
    return c.json({ isValid: false, invalidReason: "not in this test" }, 500);
  });
  const facPort = nextPort++;
  servers.push(serve({ fetch: fac.fetch, port: facPort }));
  facilitatorHost = `127.0.0.1:${facPort}`;
  const dir = (name: string) => {
    const d = mkdtempSync(path.join(tmpdir(), `flatfee-page-app-${name}-`));
    dirs.push(d);
    return d;
  };

  const onDir = dir("on");
  const onStore = new Store(onDir);
  onStore.addLedger({ kind: "hire", network: "eip155:46630", payer: buyer, tier: "holder", price: "6172562500", settleTx: `0x${"ab".repeat(32)}`, cashbackTx: null, taskId: "t1" });
  onStore.addLedger({ kind: "ask", network: "eip155:46630", payer: buyer, tier: "standard", price: "375000", settleTx: `0x${"cd".repeat(32)}`, cashbackTx: null, question: "latest block?" });
  const onEnv = {
    NETWORK: "robinhood-testnet",
    PAY_TO: payTo,
    FACILITATOR_URL: `http://${facilitatorHost}`,
    DATA_DIR: onDir,
    PRICE_ASK_USDG: "0.375",
    PRICE_ASK_HOLDER_USDG: "0.0625",
    PRICE_HIRE_USDG: "12345.125",
    PRICE_HIRE_HOLDER_USDG: "6172.5625",
    WIF_ADDRESS: Wallet.createRandom().address,
    WIF_HOLDER_MIN: "4321",
    WIF_CASHBACK: "7",
    WIF_WORKER_REWARD: "33",
    MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey,
    EM_HIRE: "on",
    EM_API_URL: "https://em.test",
    EM_ESCROW_ADDRESS: Wallet.createRandom().address,
    EM_OPERATOR_ADDRESS: Wallet.createRandom().address,
    EM_TOKEN_COLLECTOR_ADDRESS: Wallet.createRandom().address,
    EM_BOUNTY_USDG: "0.125",
    EM_DEADLINE_HOURS: "720",
  };
  on = start(onEnv, { chain: holderChain, store: onStore, emHire });
  const pausedDir = dir("paused");
  paused = start({ ...onEnv, DATA_DIR: pausedDir }, { chain: holderChain, store: new Store(pausedDir), emHire: pausedHire });

  const offDir = dir("off");
  const offStore = new Store(offDir);
  const task = offStore.createTask({ request: "Check that the cafe is open.", payer: buyer, paidTx: `0x${"ef".repeat(32)}` });
  offStore.updateTask(task.id, { status: "claimed", worker: Wallet.createRandom().address });
  claimedTask = task.id;
  const offEnv = {
    NETWORK: "robinhood-testnet",
    PAY_TO: payTo,
    FACILITATOR_URL: `http://${facilitatorHost}`,
    DATA_DIR: offDir,
    PRICE_ASK_USDG: "0.3",
    PRICE_HIRE_USDG: "2.5",
    PRICE_HIRE_HOLDER_USDG: "1.25",
    WORKER_TOKEN: "a-worker-token-of-16+",
  };
  off = start(offEnv, { chain: standardChain, store: offStore });
  fork = start(offEnv, { chain: standardChain, store: offStore, localFork: true });
});

after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Eip1193 {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
}

let pages = 0;

/**
 * Opens the page of `base` as a browser does: the HTML of GET /, then public/app.js run on it, its relative fetches sent
 * to `base` and `ethereum` as the wallet. Returns the document, the board's 4-second redraw (run by hand) and close(),
 * which puts the globals back.
 */
async function openPage(base: string, ethereum?: Eip1193) {
  const doc = new FakeDocument(await (await fetch(`${base}/`)).text());
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  const redraws: (() => Promise<void>)[] = [];
  const alerts: string[] = [];
  Object.assign(g, {
    document: doc,
    window: { ethereum },
    location: { origin: base },
    alert: (m: string) => alerts.push(m),
    fetch: (u: string | URL, init?: RequestInit) => saved.fetch(new URL(String(u), base), init),
    // app.js's own timer is the board's redraw, every 4 s: kept to be run by hand; any other timer runs as usual
    setInterval: (fn: () => Promise<void>, ms?: number) => (ms === 4000 ? redraws.push(fn) : saved.setInterval(fn, ms)),
  });
  const close = () => {
    globalThis.fetch = saved.fetch;
    globalThis.setInterval = saved.setInterval;
    for (const k of ["document", "window", "location", "alert"]) delete g[k];
  };
  try {
    // the browser resolves "/x402-browser.js?v=2" against the page; here it is the same file in public/
    let imports = 0;
    const src = readFileSync("public/app.js", "utf8").replace(/from "\/([^"?]+)(?:\?[^"]*)?"/g, (_, f: string) => {
      imports++;
      return `from ${JSON.stringify(pathToFileURL(path.resolve("public", f)).href)}`;
    });
    assert.equal(imports, 2, "app.js imports x402-browser.js and page-state.js");
    // its top level runs loadInfo(), then refresh(), then the interval; a new module each time
    await import(`data:text/javascript;base64,${Buffer.from(`${src}\n// page ${++pages}\n`).toString("base64")}`);
    assert.equal(redraws.length, 1, "app.js redraws the board on one interval");
  } catch (e) {
    close();
    throw e;
  } finally {
    globalThis.setInterval = saved.setInterval;
  }
  const $ = (sel: string): FakeElement => {
    const n = doc.querySelector(sel);
    assert.ok(n, `no ${sel} on the page`);
    return n;
  };
  return { doc, $, redraw: () => redraws[0](), alerts, close };
}

test("the page shows every amount, the network, the bounty and the deadline this server sends (escrow on, unusual values)", async () => {
  const info = await (await fetch(`${on}/api/info`)).json();
  assert.deepEqual(info.prices, { ask: { standard: "0.375", holder: "0.0625" }, hire: { standard: "12345.125", holder: "6172.5625" } });
  assert.deepEqual(info.hire, { via: "execution-market", bounty: "0.125", deadlineHours: 720, available: true, paused: null, expiry: hireExpiry(720) });
  const p = await openPage(on);
  try {
    const { doc, $ } = p;
    // the main button, the line under it, the header and the other button
    assert.equal(visibleText($("#hire-pay")), "Pay 12345.125 USDG and hire");
    assert.equal(visibleText($(".meta")), "No gas, no refunds · $WIF holders (4321+) pay 6172.5625");
    assert.equal(visibleText($(".chain")), "USDG on Robinhood Chain Testnet");
    assert.equal(visibleText($("#ask-pay")), "Pay 0.375 USDG and ask");
    // every amount and fact in the markup, by the /api/info path it names
    const amounts: Record<string, string> = { "prices.hire.standard": "12345.125", "prices.hire.holder": "6172.5625", "prices.ask.standard": "0.375", "prices.ask.holder": "0.0625" };
    const usdgNodes = doc.querySelectorAll("[data-usdg]");
    assert.ok(usdgNodes.length >= 6);
    for (const n of usdgNodes) assert.equal(n.textContent, amounts[n.dataset.usdg!], n.dataset.usdg);
    const facts: Record<string, string> = { "network.label": "Robinhood Chain Testnet", "wif.holderMin": "4321", "wif.cashback": "7", "wif.workerReward": "33" };
    const infoNodes = doc.querySelectorAll("[data-info]");
    assert.ok(infoNodes.length >= 5);
    for (const n of infoNodes) assert.equal(n.textContent, facts[n.dataset.info!], n.dataset.info);
    // $WIF, cashback and the worker reward are all on: every line that needs one shows
    const needs = doc.querySelectorAll("[data-needs]");
    assert.ok(needs.length >= 6);
    for (const n of needs) assert.equal(n.hidden, false, n.dataset.needs);
    assert.equal(visibleText($('#wif p[data-needs="wif.cashback"]')), "Cashback: each paid call sends 7 $WIF to the payer, while the day's budget lasts.");
    // escrow, as this server runs it: its bounty and its deadline
    assert.equal(doc.body.dataset.escrow, "on");
    assert.equal(visibleText($("#escrow-pill")), "Live on this demo");
    assert.equal(visibleText($("#hire-status")), "With escrow: your task goes to Execution Market, and answers show on the task board below.");
    assert.equal(visibleText($(".steps .lock")), "The worker's pay is locked in escrow: 0.125 USDG.");
    assert.equal(visibleText($("#escrow-foot")), "Escrow on Robinhood Chain Testnet. Deadline 720 h.");
    // what becomes of a hire nobody finishes, in the server's words, with this server's deadline
    assert.equal($("#escrow-expiry").hidden, false);
    assert.equal(visibleText($("#escrow-expiry")), hireExpiry(720));
    assert.match(visibleText($("#escrow-expiry")), /within 720 h/);
    // for developers: the network, who is paid, the facilitator, and this server's origin in the curl line
    assert.deepEqual(doc.querySelectorAll("#facts dd").map(visibleText), ["Robinhood Chain Testnet · eip155:46630", short(payTo), facilitatorHost]);
    assert.equal($("[data-origin]").textContent, on);
    // paid calls: each row's price as the ledger has it, newest first
    const rows = doc.querySelectorAll("#ledger li").map((li) => li.children.map(visibleText));
    assert.deepEqual(rows.map((r) => [r[1], r[3]]), [["ask", "0.375 USDG"], ["hire #t1", "6172.5625 USDG (holder)"]]);
    // a wallet can pay here
    assert.equal($("#hire-pay").disabled, false);
    assert.equal($("#fork-notice").hidden, true);
  } finally {
    p.close();
  }
});

test("with hiring paused (EM_HIRE on, the merchant cannot fund one more escrow) the page says paused, with the server's sentence word for word, never Live", async () => {
  const info = await (await fetch(`${paused}/api/info`)).json();
  const reason = "The wallet that pays the escrow cannot fund one more task right now.";
  assert.deepEqual(info.hire, { via: "execution-market", bounty: "0.125", deadlineHours: 720, available: false, paused: { kind: "funds", reason }, expiry: hireExpiry(720) });
  // the 503's detail (a wallet, an amount) is not in /api/info
  assert.ok(!JSON.stringify(info).includes("0x00000000000000000000000000000000000000ee"));
  assert.ok(!JSON.stringify(info).includes("0.25 USDG"));
  const p = await openPage(paused);
  try {
    const { doc, $ } = p;
    assert.equal(doc.body.dataset.escrow, "paused");
    assert.equal(visibleText($("#escrow-pill")), "Paused on this demo");
    assert.equal(visibleText($("#hire-status")), `Hiring is paused: ${reason}`);
    // how escrow works, as this server would run it: its bounty and deadline are still its own
    assert.equal(visibleText($(".steps .lock")), "The worker's pay is locked in escrow: 0.125 USDG.");
    assert.equal(visibleText($("#escrow-foot")), "Escrow on Robinhood Chain Testnet. Deadline 720 h.");
    assert.equal(visibleText($("#board-meta")), "tasks on Execution Market");
    assert.equal(visibleText($("#escrow-expiry")), hireExpiry(720));
    // the hire button is off, saying why; asking the agent is not affected
    assert.equal($("#hire-pay").disabled, true);
    assert.equal($("#hire-pay").title, reason);
    assert.equal($("#ask-pay").disabled, false);
    // nothing on the page says escrow runs now, and the 503's detail is nowhere on it
    const text = visibleText(doc.body);
    assert.doesNotMatch(text, /\blive\b|with escrow:|goes to Execution Market/i);
    assert.ok(!text.includes(PAUSE_DETAIL));
    assert.ok(!text.includes("0x0000…00ee"));
  } finally {
    p.close();
  }
});

test("on the task board (EM_HIRE off, no $WIF token) the page says escrow is off and mentions nothing the server did not send", async () => {
  const p = await openPage(off);
  try {
    const { doc, $ } = p;
    assert.equal(doc.body.dataset.escrow, "off");
    assert.equal(visibleText($("#escrow-pill")), "Off on this demo");
    assert.equal(visibleText($("#hire-status")), "Today, without escrow: your task goes on the task board below, for a person to answer.");
    assert.equal($("#escrow-bounty").hidden, true);
    assert.equal($("#escrow-expiry").hidden, true);
    assert.equal(visibleText($(".steps .lock")), "The worker's pay is locked in escrow.");
    assert.equal(visibleText($("#escrow-foot")), "Waiting for Execution Market's escrow on Robinhood Chain.");
    assert.equal(visibleText($("#board-meta")), "for workers: claim and answer");
    // no $WIF token, no cashback, no reward: none of them is mentioned
    const needs = doc.querySelectorAll("[data-needs]");
    assert.ok(needs.length >= 6);
    for (const n of needs) assert.equal(n.hidden, true, n.dataset.needs);
    assert.equal(visibleText($(".meta")), "No gas, no refunds");
    assert.equal(visibleText($("#board-how").parent), "Workers: enter your wallet and worker token, claim a task, send the answer.");
    // this server's prices and network
    assert.equal(visibleText($("#hire-pay")), "Pay 2.50 USDG and hire");
    assert.equal(visibleText($("#ask-pay")), "Pay 0.30 USDG and ask");
    assert.equal(visibleText($(".chain")), "USDG on Robinhood Chain Testnet");
    assert.equal(visibleText($("#ledger")), "No paid calls yet.");
    // the claimed task waits for its answer
    assert.ok($(`#tasks input[data-task="${claimedTask}"]`));
    assert.equal($("#hire-pay").disabled, false);
    assert.equal($("#fork-notice").hidden, true);
  } finally {
    p.close();
  }
});

test("the wallet is asked to sign the amount the 402 asks (here the holder price), not the listed one, and nothing settles unsigned", async () => {
  facCalls.length = 0;
  const asked: string[] = [];
  let doc: FakeDocument | null = null;
  // what the page showed when the wallet was asked to sign, and the typed data it was asked to sign
  const seen: { prompt?: string; signed?: { domain: { chainId: number }; message: { to: string; value: string } } } = {};
  const p = await openPage(on, {
    request: async ({ method, params }) => {
      asked.push(method);
      if (method === "eth_requestAccounts") return [buyer];
      if (method === "eth_chainId") return `0x${(46630).toString(16)}`;
      if (method === "eth_signTypedData_v4") {
        seen.prompt = visibleText(doc!.querySelector("#hire-out"));
        seen.signed = JSON.parse(String(params![1]));
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      }
      throw new Error(`no ${method} in this test`);
    },
  });
  doc = p.doc;
  try {
    await p.$("#hire-pay").click();
    assert.deepEqual(asked, ["eth_requestAccounts", "eth_chainId", "eth_signTypedData_v4"]);
    // the page lists 12345.125; the 402 for this holder asks 6172.5625, and that is what the prompt and the signature say
    assert.equal(visibleText(p.$("#hire-pay")), "Pay 12345.125 USDG and hire");
    assert.equal(seen.prompt, `Sign 6172.5625 USDG to ${short(payTo)} in your wallet…`);
    assert.equal(seen.signed?.message.value, "6172562500");
    assert.equal(seen.signed?.message.to, payTo);
    assert.equal(seen.signed?.domain.chainId, 46630);
    // refused in the wallet: the page says so, the button is back, no task board opened, nothing settled
    assert.equal(visibleText(p.$("#hire-out")), "User rejected the request.");
    assert.ok(p.$("#hire-out").classList.contains("bad"));
    assert.equal(p.$("#hire-pay").disabled, false);
    assert.equal(p.$("#board").open, false);
    assert.deepEqual(facCalls, []);
  } finally {
    p.close();
  }
});

test("the board's redraw keeps a worker's half-typed answer, the focus and the selection", async () => {
  const p = await openPage(off);
  try {
    const typing = p.$(`#tasks input[data-task="${claimedTask}"]`);
    typing.value = "The cafe is op";
    typing.focus();
    typing.setSelectionRange(4, 8);
    await p.redraw();
    const redrawn = p.$(`#tasks input[data-task="${claimedTask}"]`);
    assert.ok(redrawn !== typing, "the board was drawn again");
    assert.equal(redrawn.value, "The cafe is op");
    assert.ok(p.doc.activeElement === redrawn, "the focus is on the answer being typed");
    assert.deepEqual([redrawn.selectionStart, redrawn.selectionEnd], [4, 8]);
  } finally {
    p.close();
  }
});

test("on a local fork (npm run demo) the wallet buttons are off, the page says why, and no wallet is ever asked", async () => {
  const asked: string[] = [];
  const p = await openPage(fork, {
    request: async ({ method }) => {
      asked.push(method);
      throw new Error("no wallet on a fork");
    },
  });
  try {
    const blocked = walletPayBlocked({ localFork: true });
    assert.ok(blocked);
    for (const id of ["#ask-pay", "#hire-pay"]) {
      assert.equal(p.$(id).disabled, true, id);
      assert.equal(p.$(id).title, blocked, id);
    }
    assert.equal(p.$("#fork-notice").hidden, false);
    assert.equal(visibleText(p.$("#fork-notice")), blocked);
    // what is left to try there is the task board, and the paid calls the demo made
    assert.equal(p.$("#board").open, true);
    assert.equal(p.$("#calls").open, true);
    // a click that gets through anyway still never reaches the wallet
    await p.$("#hire-pay").click();
    assert.deepEqual(asked, []);
    assert.equal(visibleText(p.$("#hire-out")), blocked);
  } finally {
    p.close();
  }
});
