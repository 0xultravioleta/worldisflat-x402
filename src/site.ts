// What the server renders itself, so a reader with no JavaScript (a judge's AI assistant, an agent, a crawler) gets the
// real values: the landing page with every amount, the escrow state, the proof figures and the cards filled in
// (app.js then keeps them fresh), the /proof page, and the entries for agents (/llms.txt, /skill.md, /.well-known/x402).
// Every word and figure comes from the functions the browser uses (public/page-state.js) applied to the objects the API
// serves (/api/info, /api/proof, /api/ledger, /api/tasks), so the page without JavaScript and with it say the same.
// @ts-expect-error plain JS module shared with the browser
import * as ps from "../public/page-state.js";
import type { Config } from "./config.js";
import type { Proof, ProofTx, WorkCard } from "./proof.js";

const { escrowCopy, flowCopy, isAbsent, plain, proofCopy, short, txRows, usdg, utcDate, valueAt, workCardView, workMeta } = ps as Record<string, any>;

/** text or attribute value, escaped for HTML */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const a = (href: string | null | undefined, text: string, cls = "") =>
  href ? `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>` : "—";

export interface PageCtx {
  cfg: Config;
  /** GET /api/info */
  info: any;
  /** GET /api/proof */
  proof: Proof;
  /** GET /api/ledger */
  ledger: any[];
  /** GET /api/tasks */
  tasks: any[];
  /** where this server is reached: PUBLIC_URL, else the request's origin */
  origin: string;
}

/** a replacement that must find its spot in the template: a page that changed shape fails loudly, not half filled */
function sub(html: string, re: RegExp, to: (...m: string[]) => string, what: string): string {
  let n = 0;
  const out = html.replace(re, (...m) => {
    n++;
    return to(...(m as string[]));
  });
  if (!n) throw new Error(`page template: ${what} not found`);
  return out;
}
const setText = (html: string, id: string, text: string) => sub(html, new RegExp(`(id="${id}"[^>]*>)[^<]*(<)`), (_, p, q) => `${p}${esc(text)}${q}`, `#${id}`);
const setInner = (html: string, open: string, inner: string) =>
  sub(html, new RegExp(`(${open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[\\s\\S]*?(</(?:ul|dl)>)`), (_, p, q) => `${p}${inner}${q}`, open);

function txRowsHtml(p: Proof) {
  const rows = txRows(p) as { at: string; what: string; url: string; tx: string }[];
  return rows.length
    ? rows.map((r) => `<li><span class="w">${esc(r.at)}</span><span>${esc(r.what)}</span>${a(r.url, r.tx)}</li>`).join("")
    : `<li class="empty">No transactions to show yet.</li>`;
}

function workHtml(w: WorkCard) {
  const v = workCardView(w);
  return (
    `<li class="job"><p class="job-top"><span class="st ${esc(v.status)}">${esc(v.status)}</span>${esc(v.kind)}${esc(v.ref)}</p>` +
    `<p class="${v.titled ? "job-title" : "job-title none"}">${esc(v.title)}</p>` +
    `<p class="job-who"><b>${esc(v.from)}</b> → ${esc(v.to)}</p>` +
    `<p class="job-amt">${esc(v.amount)}<span class="w">${esc(v.paid)}</span></p>` +
    `<p class="job-amt"><span class="w">${esc(v.at)}</span></p>` +
    `<p class="job-links">${v.links.map((l: { href: string; text: string }) => a(l.href, l.text)).join("")}</p></li>`
  );
}

function ledgerHtml(ledger: any[]) {
  if (!ledger.length) return `<li class="empty" role="row"><span role="cell">No paid calls yet.</span></li>`;
  return ledger
    .map(
      (e) =>
        `<li role="row"><span role="cell">${esc(utcDate(e.at))}</span><span role="cell">${esc(e.kind === "ask" ? "ask" : `hire #${e.taskId}`)}</span>` +
        `<span role="cell" class="mono" data-k="payer">${esc(short(e.payer))}</span>` +
        `<span role="cell">${esc(`${usdg(e.price)} USDG${e.tier === "holder" ? " (holder)" : ""}`)}</span>` +
        `<span role="cell" class="mono" data-k="settlement">${a(e.settleUrl, short(e.settleTx))}</span>` +
        `<span role="cell" class="mono" data-k="$WIF back">${e.cashbackTx ? a(e.cashbackUrl, short(e.cashbackTx)) : e.cashbackError ? "failed" : "—"}</span></li>`,
    )
    .join("");
}

function tasksHtml(tasks: any[], explorer: string) {
  if (!tasks.length) return `<li class="empty">No tasks yet. Hire a human above.</li>`;
  return tasks
    .map((t) => {
      const em = t.via === "em" ? `<p class="tm">on Execution Market · ${esc(t.em?.status ?? t.em?.step ?? "publishing")}</p>` : "";
      return (
        `<li><div><p class="q"><span class="badge">${esc(t.status)}</span>${esc(t.request)}</p>` +
        `<p class="tm">#${esc(t.id)} · paid by ${esc(short(t.payer))} · ${a(t.paidTx ? `${explorer}/tx/${t.paidTx}` : null, "payment")}</p>` +
        `${t.answer ? `<p class="answer">${esc(t.answer)}</p>` : ""}${em}</div></li>`
      );
    })
    .join("");
}

/** the landing page (public/index.html) with what this server says now: what app.js would draw, before any script runs */
export function renderLanding(tpl: string, { info, proof, ledger, tasks, origin }: PageCtx): string {
  let h = tpl;
  // amounts and facts from /api/info, and the lines that need one
  h = h.replace(/(data-usdg="([^"]+)"[^>]*>)…</g, (m, p, path) => {
    const v = valueAt(info, path);
    return v == null ? m : `${p}${esc(usdg(v))}<`;
  });
  h = h.replace(/(data-info="([^"]+)"[^>]*>)[^<]*</g, (m, p, path) => {
    const v = valueAt(info, path);
    return v == null ? m : `${p}${esc(v)}<`;
  });
  h = h.replace(/data-needs="([^"]+)" hidden/g, (m, path) => (isAbsent(valueAt(info, path)) ? m : `data-needs="${path}"`));
  h = sub(h, /(<span data-origin>)&lt;origin&gt;(<)/, (_, p, q) => `${p}${esc(origin)}${q}`, "data-origin");

  // the hire's escrow state, in page-state.js's words
  const c = escrowCopy(info);
  h = sub(h, /<body data-escrow="off">/, () => `<body data-escrow="${esc(c.escrow)}">`, "body");
  for (const [id, k] of [["escrow-pill", "pill"], ["hire-status-label", "statusLabel"], ["hire-status-text", "statusText"], ["escrow-foot", "foot"], ["board-meta", "boardMeta"], ["board-how", "boardHow"]]) {
    h = setText(h, id, c[k]);
  }
  if (c.bounty) {
    h = sub(h, /<span id="escrow-bounty" hidden>/, () => `<span id="escrow-bounty">`, "#escrow-bounty");
    h = setText(h, "escrow-bounty-amount", c.bounty);
  }
  if (c.expiry) h = sub(h, /(<p class="strip-note" id="escrow-expiry") hidden>(<\/p>)/, (_, p, q) => `${p}>${esc(c.expiry)}${q}`, "#escrow-expiry");

  // for developers
  const facts =
    `<dt>Network</dt><dd>${esc(`${info.network.label} · ${info.network.caip2}`)}</dd>` +
    `<dt>Paid to</dt><dd>${a(info.payToUrl, short(info.payTo))}</dd>` +
    `<dt>Facilitator</dt><dd>${esc(String(info.facilitator).replace(/^https?:\/\//, ""))}</dd>`;
  h = setInner(h, `<dl class="facts" id="facts">`, facts);

  // the proof strip, the transactions behind it, the escrowed work and where a hire's money goes
  const pc = proofCopy(proof);
  const stat = (id: string, n: string, s?: string) => {
    h = sub(h, new RegExp(`(id="${id}"[^>]*><span class="n">)[^<]*(</span>)`), (_, p, q) => `${p}${esc(n)}${q}`, `#${id} .n`);
    if (s != null) h = sub(h, new RegExp(`(id="${id}"[^>]*>(?:<span[^>]*>[^<]*</span>){2}<span class="s">)[^<]*(</span>)`), (_, p, q) => `${p}${esc(s)}${q}`, `#${id} .s`);
  };
  stat("stat-calls", pc.calls);
  stat("stat-usdg", pc.usdg);
  stat("stat-wif", pc.wif, pc.wifSub);
  stat("stat-escrow", pc.escrows, pc.escrowSub);
  h = setText(h, "proof-note", pc.note);
  h = sub(h, /(id="proof-merchant" href=")[^"]*(")/, (_, p, q) => `${p}${esc(proof.merchantUrl)}${q}`, "#proof-merchant");
  h = setInner(h, `<ul class="txs" id="tx-list">`, txRowsHtml(proof));
  h = setText(h, "work-meta", workMeta(proof));
  h = setInner(h, `<ul class="work" id="work">`, proof.work.length ? proof.work.map(workHtml).join("") : `<li class="empty">No escrowed work to show yet.</li>`);
  const f = flowCopy(info, proof);
  if (f) {
    h = sub(h, /(id="flow" aria-labelledby="flow-h") hidden>/, (_, p) => `${p}>`, "#flow");
    for (const k of ["pay", "payHolder", "bounty", "keep", "keepHolder", "worker", "fee", "feeAmount"]) h = setText(h, `flow-${k}`, f[k]);
    h = sub(h, /(id="flow-fee-tx" href=")[^"]*(")/, (_, p, q) => `${p}${esc(f.feeUrl)}${q}`, "#flow-fee-tx");
    if (f.reward) {
      h = sub(h, /<span id="flow-reward" hidden>/, () => `<span id="flow-reward">`, "#flow-reward");
      h = setText(h, "flow-reward-n", f.reward);
    }
  }

  // this server's paid calls and its task board
  h = setInner(h, `<ul class="ledger" id="ledger" role="rowgroup">`, ledgerHtml(ledger));
  h = setInner(h, `<ul class="tasks" id="tasks">`, tasksHtml(tasks, info.network.explorer));
  return h;
}

// ---------------------------------------------------------------------------------------------------------------------
// /proof

function shell(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="theme-color" content="#0f1412" />
  <link rel="icon" href="/logo.png" />
  <link rel="stylesheet" href="/style.css?v=5" />
</head>
<body data-escrow="on" class="doc">
  <header class="top">
    <div class="wrap bar">
      <a class="brand" href="/"><img src="/logo.png" alt="" width="28" height="28" />Flat Fee</a>
      <nav class="nav" aria-label="Sections"><a href="/">Home</a><a href="/proof">Proof</a><a href="/skill.md">For agents</a><a href="https://github.com/0xultravioleta/worldisflat-x402">GitHub</a></nav>
    </div>
  </header>
  <main class="wrap">
${body}
  </main>
  <footer class="wrap foot">
    <p>Built by Ultravioleta DAO for the world is flat hackathon. Open source, MIT. Flat Fee is not affiliated with, endorsed by,
      or officially connected with Robinhood Markets, Inc.</p>
    <p><a href="/">flat fee</a> · <a href="/llms.txt">llms.txt</a> · <a href="/skill.md">skill.md</a> · <a href="/.well-known/x402">.well-known/x402</a> · <a href="/api/proof">/api/proof</a></p>
  </footer>
</body>
</html>
`;
}

const block = (b: number | undefined) => (b ? Number(b).toLocaleString("en-US") : "—");

function txTable(caption: string, rows: ProofTx[], amount: (t: ProofTx) => string) {
  if (!rows.length) return "";
  return (
    `<table class="ptable"><caption>${esc(caption)}</caption><thead><tr><th>when (UTC)</th><th>block</th><th>amount</th><th>transaction</th></tr></thead><tbody>` +
    rows
      .map((t) => `<tr><td>${esc(utcDate(t.at))}</td><td class="mono">${esc(block(t.block))}</td><td class="mono">${esc(amount(t))}</td><td class="mono">${a(t.url, short(t.tx))}</td></tr>`)
      .join("") +
    `</tbody></table>`
  );
}

function workTable(caption: string, rows: WorkCard[]) {
  if (!rows.length) return "";
  return (
    `<table class="ptable"><caption>${esc(caption)}</caption><thead><tr><th>task</th><th>who</th><th>escrow lock</th><th>payment out of escrow</th></tr></thead><tbody>` +
    rows
      .map(
        (w) =>
          `<tr><td>${w.page ? a(w.page, `#${w.ref}`) : esc(`#${w.ref}`)}<br /><span class="w">${esc(w.status)}</span></td>` +
          `<td>${esc(w.from)} → ${esc(w.to)}</td>` +
          `<td class="mono">${w.escrowUrl ? `${a(w.escrowUrl, short(w.escrowTx))}<br /><span class="w">${esc(w.bounty ? `${usdg(w.bounty)} USDG · block ${block(w.escrowBlock)}` : `block ${block(w.escrowBlock)}`)}</span>` : "not in this record"}</td>` +
          `<td class="mono">${w.paymentUrl ? `${a(w.paymentUrl, short(w.paymentTx))}<br /><span class="w">${esc(w.paid ? `${usdg(w.paid)} USDG to whoever delivered · block ${block(w.paymentBlock)}` : `block ${block(w.paymentBlock)}`)}</span>` : "—"}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`
  );
}

/** GET /proof: every contract, wallet and transaction behind the figures, and how to check each one by RPC */
export function renderProofPage({ cfg, info, proof, origin }: PageCtx): string {
  const pc = proofCopy(proof);
  const explorer = cfg.chain.explorer;
  const addr = (x: string) => a(`${explorer}/address/${x}`, x, "mono");
  const contracts: [string, string, string][] = [[`USDG (${cfg.chain.label})`, cfg.chain.usdg, "the token every price is paid in; its EIP-712 domain is Global Dollar, version 1"]];
  if (cfg.wif.token) contracts.push(["$WIF", cfg.wif.token, "the cashback, the holder price and the workers' reward"]);
  contracts.push(["Flat Fee's merchant wallet", cfg.payTo, "receives each payment, sends the $WIF and funds the hires' escrow"]);
  if (proof.facilitator) contracts.push(["Ultravioleta's x402 facilitator", proof.facilitator, "submits each settlement and pays its gas"]);
  if (cfg.em) {
    contracts.push(["Execution Market's escrow", cfg.em.escrow.escrow, "holds a worker's pay between the lock and its release"]);
    contracts.push(["Execution Market's operator", cfg.em.escrow.operator, "receives Execution Market's fee when the escrow pays out"]);
    contracts.push(["Execution Market's token collector", cfg.em.escrow.tokenCollector, "takes the locked USDG into the escrow"]);
  }
  if (proof.identity) {
    const ids = [proof.identity.robinhood ? `agent ${proof.identity.robinhood} on ${cfg.chain.label}` : null, proof.identity.base ? `agent ${proof.identity.base} on Base` : null].filter(Boolean).join(", ");
    contracts.push(["ERC-8004 identity registry", proof.identity.registry, `Flat Fee's merchant is ${ids}; no ratings are written on ${cfg.chain.label} yet`]);
  }
  const first = proof.paidCalls.txs[0]?.tx ?? proof.escrows.txs[0]?.tx ?? null;
  const flatfee = proof.work.filter((w) => w.kind === "flatfee");
  const swarm = proof.work.filter((w) => w.kind === "swarm");
  const rpc = cfg.chain.publicRpcUrl;
  const body = `
    <section class="hero">
      <p class="eyebrow">Proof · ${esc(cfg.chain.label)} · chain id ${esc(cfg.chain.chainId)}</p>
      <h1>Every contract, wallet and transaction behind Flat Fee</h1>
      <p class="sub">${esc(pc.note)}</p>
      <div class="stats">
        <div class="stat"><span class="n">${esc(pc.calls)}</span><span class="l">paid calls settled</span><span class="s">x402, USDG</span></div>
        <div class="stat"><span class="n">${esc(pc.usdg)}</span><span class="l">USDG settled</span><span class="s">into the merchant</span></div>
        <div class="stat"><span class="n">${esc(pc.wif)}</span><span class="l">$WIF paid out</span><span class="s">${esc(pc.wifSub)}</span></div>
        <div class="stat"><span class="n">${esc(pc.escrows)}</span><span class="l">hires paid from escrow</span><span class="s">${esc(pc.escrowSub)}</span></div>
      </div>
    </section>
    <section class="doc-sec">
      <h2 class="h2">Contracts and wallets on ${esc(cfg.chain.label)}</h2>
      <table class="ptable"><thead><tr><th>what</th><th>address</th><th>its part</th></tr></thead><tbody>
${contracts.map(([what, x, part]) => `        <tr><td>${esc(what)}</td><td>${addr(x)}</td><td>${esc(part)}</td></tr>`).join("\n")}
      </tbody></table>
    </section>
    <section class="doc-sec">
      <h2 class="h2">The transactions</h2>
      ${txTable("Paid calls: USDG into the merchant, settled by the facilitator", proof.paidCalls.txs, (t) => `${usdg(t.amount)} USDG`)}
      ${txTable("$WIF cashback to the payers", proof.wif.txs.filter((t) => t.kind === "cashback"), (t) => `${plain(t.amount)} $WIF`)}
      ${txTable("$WIF to the workers whose answer Flat Fee approved", proof.wif.txs.filter((t) => t.kind === "reward"), (t) => `${plain(t.amount)} $WIF`)}
      ${workTable("Flat Fee's hires through Execution Market: the worker's pay locked, then paid out", flatfee)}
      ${workTable(`The KarmaKadabra swarm on the same market, agent to agent (${proof.swarmPaid} paid out of escrow; Flat Fee is not a party)`, swarm)}
    </section>
    <section class="doc-sec">
      <h2 class="h2">Check any of them yourself</h2>
      <p class="card-sub">Ask ${esc(cfg.chain.label)}'s public RPC for a receipt. <code>status</code> <code>0x1</code> means it went through; each USDG or $WIF movement is a <code>Transfer</code> log of that token (topic <code>0xddf252ad…</code>) with the sender and the receiver in topics 1 and 2 and the amount in <code>data</code> (USDG has 6 decimals, $WIF 18).</p>
<pre class="code">curl -s -X POST ${esc(rpc)} \\
  -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${esc(first ?? "0x<transaction hash>")}"]}'</pre>
      <p class="card-sub">The same figures as JSON: <a href="/api/proof">${esc(origin)}/api/proof</a>. The dated reads behind them, with every block and sender: <a href="https://github.com/0xultravioleta/worldisflat-x402/tree/main/docs/evidence">docs/evidence</a>. What this server charges now: <a href="/api/info">${esc(origin)}/api/info</a>.</p>
    </section>`;
  void info;
  return shell("Flat Fee proof", "Every contract, wallet and transaction behind Flat Fee on Robinhood Chain, and how to check each one by RPC.", body);
}

// ---------------------------------------------------------------------------------------------------------------------
// for agents

export const SENTENCE = "Flat Fee is a pay-per-call storefront on Robinhood Chain: sign one flat USDG payment to ask an AI agent or hire a human. No account, no API key, no gas.";

/** a call's terms as this server's own 402 gives them, or its refusal (a paused hire answers 503) */
export interface Quote {
  status: number;
  body: any;
}

function priceLine(info: any, route: "ask" | "hire") {
  const p = info.prices[route];
  return `${usdg(p.standard)} USDG (${usdg(p.holder)} for a wallet holding ${info.wif.holderMin}+ $WIF, named in the X-Payer header before the 402)`;
}

/** GET /llms.txt */
export function llmsTxt({ info, origin }: PageCtx): string {
  return `# Flat Fee

> ${SENTENCE}

Flat Fee sells two HTTP calls, priced in USDG on ${info.network.label} (${info.network.caip2}) and paid over x402: the endpoint answers 402 Payment Required with the terms, the buyer signs one EIP-3009 authorization (scheme "exact"), and Ultravioleta's x402 facilitator settles it on chain and pays the gas.

- POST ${origin}/api/ask with {"question": "..."}: an answer read from the chain (balances, latest block and gas, $WIF, x402 schemes). ${priceLine(info, "ask")}.
- POST ${origin}/api/hire with {"request": "..."}: a small task answered in text by a person${info.hire?.via === "execution-market" ? `, published on Execution Market with ${usdg(info.hire.bounty)} USDG of the worker's pay in escrow` : ""}. ${priceLine(info, "hire")}. Poll the task at the "poll" path the response gives.
${isAbsent(info.wif.cashback) ? "" : `\nEach settled call sends ${info.wif.cashback} $WIF back to the payer while the day's budget lasts.\n`}
## Docs

- [How an agent pays, with this server's real 402](${origin}/skill.md)
- [x402 discovery](${origin}/.well-known/x402)
- [Proof: every contract, wallet and transaction](${origin}/proof)
- [Prices, network and escrow state now (JSON)](${origin}/api/info)
- [Proof figures (JSON)](${origin}/api/proof)
- [Source code, MIT](https://github.com/0xultravioleta/worldisflat-x402)
`;
}

/** GET /skill.md */
export function skillMd({ info, origin }: PageCtx, ask: Quote, hire: Quote): string {
  const accept = ask.body?.accepts?.[0];
  const hireNote =
    hire.status === 402
      ? `It answers 402 with the hire's terms (${usdg(info.prices.hire.standard)} USDG), paid the same way.`
      : `Right now it answers ${hire.status}: ${hire.body?.error ?? "hiring is not available"}. Ask again later; nothing is charged before the 402.`;
  return `---
name: flat-fee
description: Pay Flat Fee in USDG over x402 on ${info.network.label} to ask an agent a question or hire a human for a small task. One EIP-3009 signature, no account, no API key, no gas.
---

# Flat Fee: pay per call over x402

${SENTENCE}

Network: ${info.network.label}, \`${info.network.caip2}\` (chain id ${info.network.chainId}). Asset: USDG \`${info.usdg}\`. Paid to: \`${info.payTo}\`. Facilitator: ${info.facilitator}.

## 1. Ask for the price

\`\`\`bash
curl -i -X POST ${origin}/api/ask -H 'content-type: application/json' -d '{"question":"What is the latest block?"}'
\`\`\`

This server's answer, as it gave it when this file was served (HTTP ${ask.status}):

\`\`\`json
${JSON.stringify(ask.body, null, 2)}
\`\`\`

To get the holder price, send \`X-Payer: <your address>\` with that request: a wallet holding ${info.wif.holderMin}+ $WIF is quoted ${usdg(info.prices.ask.holder)} USDG instead of ${usdg(info.prices.ask.standard)}, and the price is checked again against the address that signs.

## 2. Sign one EIP-3009 authorization

Sign \`TransferWithAuthorization\` (EIP-712) with the domain \`{ name: "${accept?.extra?.name ?? "Global Dollar"}", version: "${accept?.extra?.version ?? "1"}", chainId: ${info.network.chainId}, verifyingContract: "${accept?.asset ?? info.usdg}" }\` and the message \`{ from: <you>, to: "${accept?.payTo ?? info.payTo}", value: "${accept?.amount ?? ""}", validAfter: "0", validBefore: <now + ${accept?.maxTimeoutSeconds ?? 300}>, nonce: <32 random bytes> }\`. No gas, no approve.

## 3. Send it again with the payment

Base64 of this JSON goes in the \`X-PAYMENT\` header (or \`PAYMENT-SIGNATURE\`), on the same request:

\`\`\`json
{ "x402Version": 2, "scheme": "exact", "network": "${info.network.caip2}", "payload": { "signature": "0x…", "authorization": { "from": "0x…", "to": "${accept?.payTo ?? info.payTo}", "value": "${accept?.amount ?? ""}", "validAfter": "0", "validBefore": "…", "nonce": "0x…" } } }
\`\`\`

The facilitator settles it on chain, then the answer comes back with a \`receipt\`: the settlement transaction${isAbsent(info.wif.cashback) ? "" : ` and the ${info.wif.cashback} $WIF cashback`}. Each authorization is served once.

## Hire a human

\`POST ${origin}/api/hire\` with \`{"request": "<a small task, answered in text, at most 500 characters>"}\`. ${hireNote} The paid response gives a \`poll\` path (\`/api/tasks/<id>\`) where the answer appears.${info.hire?.expiry ? ` ${info.hire.expiry}` : ""}

## Without writing the signing code

- From a clone of https://github.com/0xultravioleta/worldisflat-x402: \`npm run buy -- "latest block?"\` signs, pays and prints the answer and the transaction.
- The public npm package \`uvd-x402-sdk\` builds the same payment header; Flat Fee's server uses it for its paywall.

More: ${origin}/llms.txt · ${origin}/.well-known/x402 · ${origin}/proof
`;
}

/**
 * GET /.well-known/x402: the paid resources in the shape uvd-x402-sdk's discovery registry serves them (url, type,
 * x402Version, description, accepts), with the accepts copied from this server's own 402s, plus the service in the shape
 * Execution Market publishes at its /.well-known/x402 (provider, capabilities, facilitator, networks, endpoints,
 * discovery, identity).
 */
export function wellKnownX402({ cfg, info, proof, origin }: PageCtx, quotes: { route: "ask" | "hire"; quote: Quote }[]) {
  const bodies: Record<string, string> = { ask: '{"question": string, at most 500 characters}', hire: '{"request": string, at most 500 characters}' };
  const descriptions: Record<string, string> = {
    ask: `Ask the Flat Fee agent a question about ${info.network.label}`,
    hire: info.hire?.via === "execution-market" ? "Hire a human for a small task, on Execution Market" : "Hire a human for a small task",
  };
  const endpoints = Object.fromEntries(
    (["ask", "hire"] as const).map((r) => [
      r,
      {
        method: "POST",
        path: `/api/${r}`,
        url: `${origin}/api/${r}`,
        description: descriptions[r],
        body: bodies[r],
        pricing: { asset: "USDG", standard: info.prices[r].standard, holder: info.prices[r].holder, holderMin: `${info.wif.holderMin} $WIF` },
      },
    ]),
  );
  return {
    x402: {
      version: "1.0",
      description: SENTENCE,
      provider: { name: "Flat Fee", url: origin, source: "https://github.com/0xultravioleta/worldisflat-x402" },
      capabilities: { payments: true, escrow: info.hire?.via === "execution-market", gasless: true, eip3009: true },
      facilitator: info.facilitator,
      defaultNetwork: cfg.chain.name,
      networks: [{ name: cfg.chain.name, chainId: cfg.chain.chainId, type: "evm", tokens: [{ symbol: "USDG", address: cfg.chain.usdg, decimals: 6 }] }],
      endpoints,
      discovery: { llms: `${origin}/llms.txt`, skill: `${origin}/skill.md`, proof: `${origin}/proof`, info: `${origin}/api/info` },
      ...(proof.identity?.robinhood ? { identity: { protocol: "ERC-8004", agentId: Number(proof.identity.robinhood), network: cfg.chain.name, registry: proof.identity.registry } } : {}),
    },
    // only what answers 402 right now is listed as payable (a paused hire answers 503 and is left out)
    resources: quotes
      .filter((q) => q.quote.status === 402 && Array.isArray(q.quote.body?.accepts))
      .map((q) => ({ url: `${origin}/api/${q.route}`, type: "http", x402Version: q.quote.body.x402Version ?? 2, description: descriptions[q.route], accepts: q.quote.body.accepts })),
  };
}
