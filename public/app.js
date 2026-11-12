import { paymentHeader, typedDataFor, walletPayBlocked } from "/x402-browser.js?v=2";
// where a hire's money goes (page-state.js flowCopy) does not change while the server runs: the server renders it
import { escrowCopy, isAbsent, proofCopy, short, txRows, usdg, valueAt, workCardView, workMeta } from "/page-state.js?v=5";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
};
const link = (href, text) => (href ? el("a", { href, target: "_blank", rel: "noopener" }, text) : document.createTextNode("—"));

let info;

async function loadInfo() {
  info = await (await fetch("/api/info")).json();
  // amounts and facts from the server; a value it does not send keeps the static text
  document.querySelectorAll("[data-usdg]").forEach((n) => {
    const v = valueAt(info, n.dataset.usdg);
    if (v != null) n.textContent = usdg(v);
  });
  document.querySelectorAll("[data-info]").forEach((n) => {
    const v = valueAt(info, n.dataset.info);
    if (v != null) n.textContent = v;
  });
  // nothing about $WIF without a token, no cashback line at 0, no worker reward at 0
  document.querySelectorAll("[data-needs]").forEach((n) => (n.hidden = isAbsent(valueAt(info, n.dataset.needs))));
  document.querySelectorAll("[data-origin]").forEach((n) => (n.textContent = location.origin));
  const f = $("#facts");
  f.replaceChildren();
  const fact = (k, v) => f.append(el("dt", {}, k), el("dd", {}, v));
  fact("Network", `${info.network.label} · ${info.network.caip2}`);
  fact("Paid to", link(info.payToUrl, short(info.payTo)));
  fact("Facilitator", info.facilitator.replace(/^https?:\/\//, ""));

  // escrow is said to run only when this server hires through Execution Market and says a hire would be taken now;
  // while it is paused, the page says so with the server's own reason (page-state.js)
  const copy = escrowCopy(info);
  document.body.dataset.escrow = copy.escrow;
  $("#escrow-pill").textContent = copy.pill;
  $("#hire-status-label").textContent = copy.statusLabel;
  $("#hire-status-text").textContent = copy.statusText;
  $("#escrow-bounty").hidden = !copy.bounty;
  if (copy.bounty) $("#escrow-bounty-amount").textContent = copy.bounty;
  $("#escrow-expiry").hidden = !copy.expiry;
  if (copy.expiry) $("#escrow-expiry").textContent = copy.expiry;
  $("#escrow-foot").textContent = copy.foot;
  $("#board-meta").textContent = copy.boardMeta;
  $("#board-how").textContent = copy.boardHow;

  const blocked = walletPayBlocked(info);
  for (const b of [$("#ask-pay"), $("#hire-pay")]) {
    b.disabled = !!blocked;
    if (blocked) b.title = blocked;
  }
  // hiring paused: nobody is asked to connect a wallet for a hire the server would refuse before its 402
  if (!blocked && copy.escrow === "paused") {
    $("#hire-pay").disabled = true;
    $("#hire-pay").title = copy.statusText;
  }
  if (blocked) {
    // a local fork (npm run demo): the demo already paid; what is left to try is the task board
    $("#fork-notice").textContent = blocked;
    $("#fork-notice").hidden = false;
    $("#board").open = true;
    $("#calls").open = true;
  }
}

function show(out, value, bad = false) {
  out.hidden = false;
  out.classList.toggle("bad", bad);
  out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function wallet() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet found. To pay from a terminal, see “For agents and developers” below.");
  const [from] = await eth.request({ method: "eth_requestAccounts" });
  const hex = "0x" + info.network.chainId.toString(16);
  if ((await eth.request({ method: "eth_chainId" })) !== hex) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: info.network.label, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [info.network.rpcUrl], blockExplorerUrls: [info.network.explorer] }],
      });
    }
  }
  return { eth, from };
}

/** 402 -> sign in the wallet -> retry with X-PAYMENT; true once a paid call answered 2xx */
async function payAndCall(path, body, out, button) {
  const blocked = walletPayBlocked(info);
  if (blocked) {
    show(out, blocked, true);
    return false;
  }
  button.disabled = true;
  try {
    const { eth, from } = await wallet();
    const init = { method: "POST", headers: { "content-type": "application/json", "x-payer": from }, body: JSON.stringify(body) };
    const first = await fetch(path, init);
    if (first.status !== 402) {
      show(out, await first.json(), !first.ok);
      return false;
    }
    const terms = await first.json();
    const accept = terms.accepts[0];
    show(out, `Sign ${usdg(Number(accept.amount) / 1e6)} USDG to ${short(accept.payTo)} in your wallet…`);
    const typed = typedDataFor(accept, from);
    const signature = await eth.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify({ ...typed, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ], ...typed.types } })] });
    show(out, `Settling on ${info.network.label}…`);
    const paid = await fetch(path, { ...init, headers: { ...init.headers, "X-PAYMENT": paymentHeader(accept, typed, signature) } });
    show(out, await paid.json(), !paid.ok);
    refresh();
    return paid.ok;
  } catch (e) {
    show(out, e.message || String(e), true);
    return false;
  } finally {
    button.disabled = false;
  }
}

$("#ask-quote").onclick = async () => {
  const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: $("#question").value }) });
  show($("#ask-out"), { status: r.status, body: await r.json() }, r.status !== 402);
};
$("#ask-pay").onclick = (e) => payAndCall("/api/ask", { question: $("#question").value }, $("#ask-out"), e.currentTarget);
$("#hire-pay").onclick = async (e) => {
  // a paid hire lands on the task board: open it so the buyer sees the task and, later, the answer
  if (await payAndCall("/api/hire", { request: $("#request").value }, $("#hire-out"), e.currentTarget)) $("#board").open = true;
};

async function taskAction(id, action, extra = {}) {
  const r = await fetch(`/api/tasks/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-token": $("#worker-token").value },
    body: JSON.stringify({ worker: $("#worker").value.trim(), ...extra }),
  });
  if (!r.ok) alert((await r.json()).error);
  refresh();
}

function taskItem(t, drafts) {
  const body = el("div", {},
    el("p", { class: "q" }, el("span", { class: "badge" }, t.status), t.request),
    el("p", { class: "tm" }, `#${t.id} · paid by ${short(t.payer)} · `, link(t.paidTx && info ? `${info.network.explorer}/tx/${t.paidTx}` : null, "payment")));
  if (t.answer) body.append(el("p", { class: "answer" }, t.answer));
  const li = el("li", {}, body);
  if (t.via === "em") {
    // taken and delivered on Execution Market, not on this board
    body.append(el("p", { class: "tm" }, `on Execution Market · ${t.em?.status ?? t.em?.step ?? "publishing"}`));
  } else if (t.status === "open") {
    const b = el("button", { class: "btn", type: "button" }, "Claim");
    b.onclick = () => taskAction(t.id, "claim");
    li.append(b);
  } else if (t.status === "claimed") {
    const input = el("input", { "aria-label": "Your answer", placeholder: "your answer", "data-task": t.id });
    input.value = drafts.get(t.id) ?? "";
    const b = el("button", { class: "btn", type: "button" }, "Complete");
    b.onclick = () => taskAction(t.id, "complete", { answer: input.value });
    li.append(el("div", { class: "row" }, input, b));
  }
  return li;
}

// the proof strip, the transactions behind it and the work paid out of escrow (GET /api/proof, src/proof.ts)
let lastProof = null;

function setStat(id, n, sub) {
  $(`#${id} .n`).textContent = n;
  if (sub != null) $(`#${id} .s`).textContent = sub;
}

function renderProof(p) {
  const c = proofCopy(p);
  setStat("stat-calls", c.calls);
  setStat("stat-usdg", c.usdg);
  setStat("stat-wif", c.wif, c.wifSub);
  setStat("stat-escrow", c.escrows, c.escrowSub);
  $("#proof-note").textContent = c.note;
  $("#proof-note").classList.toggle("bad", !p);
  if (!p) return;
  $("#proof-merchant").setAttribute("href", p.merchantUrl);
  // every transaction behind the figures, newest first (the same rows the server draws: page-state.js txRows)
  const rows = txRows(p);
  $("#tx-list").replaceChildren(
    ...(rows.length
      ? rows.map((r) => el("li", {}, el("span", { class: "w" }, r.at), el("span", {}, r.what), link(r.url, r.tx)))
      : [el("li", { class: "empty" }, "No transactions to show yet.")]),
  );
  // the work paid out of escrow: Flat Fee's hires and the swarm's tasks on the same market
  $("#work-meta").textContent = workMeta(p);
  $("#work").replaceChildren(...(p.work.length ? p.work.map(workCard) : [el("li", { class: "empty" }, "No escrowed work to show yet.")]));
}

function workCard(w) {
  const v = workCardView(w);
  return el("li", { class: "job" },
    el("p", { class: "job-top" }, el("span", { class: `st ${v.status}` }, v.status), v.kind, v.ref),
    el("p", { class: v.titled ? "job-title" : "job-title none" }, v.title),
    el("p", { class: "job-who" }, el("b", {}, v.from), " → ", v.to),
    el("p", { class: "job-amt" }, v.amount, el("span", { class: "w" }, v.paid)),
    el("p", { class: "job-amt" }, el("span", { class: "w" }, v.at)),
    el("p", { class: "job-links" }, ...v.links.map((l) => link(l.href, l.text))),
  );
}

async function loadProof() {
  try {
    const r = await fetch("/api/proof");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text === lastProof) return;
    renderProof(JSON.parse(text));
    lastProof = text;
  } catch {
    // keep what was already shown; say so only when nothing was ever read
    if (lastProof === null) renderProof(null);
  }
}

// a figure of the proof strip opens the list of its transactions
for (const a of document.querySelectorAll('a.stat[href="#txs"]')) a.onclick = () => ($("#txs").open = true);

// the demo video: a plain button (no thumbnail, nothing from YouTube) until clicked; the click loads YouTube's player
$("#video-play").onclick = (e) => {
  const id = e.currentTarget.dataset.video;
  const frame = el("iframe", {
    src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`,
    title: "Flat Fee demo video",
    allow: "autoplay; encrypted-media; picture-in-picture",
    allowfullscreen: "",
  });
  $("#video-box").replaceChildren(frame);
};
$("#copy-curl").onclick = async (e) => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText($("#curl").textContent);
    b.textContent = "Copied";
  } catch {
    b.textContent = "Select and copy";
  }
};

async function refresh() {
  await loadProof();
  const [ledger, tasks] = await Promise.all([(await fetch("/api/ledger")).json(), (await fetch("/api/tasks")).json()]);
  $("#ledger").replaceChildren(
    // rows of the role="table" in index.html; data-k labels the cells on a phone, where the header row is hidden
    ...(ledger.length ? ledger.map((e) => el("li", { role: "row" },
      el("span", { role: "cell" }, new Date(e.at).toLocaleTimeString()),
      el("span", { role: "cell" }, e.kind === "ask" ? "ask" : `hire #${e.taskId}`),
      el("span", { role: "cell", class: "mono", "data-k": "payer" }, short(e.payer)),
      el("span", { role: "cell" }, `${usdg(e.price)} USDG${e.tier === "holder" ? " (holder)" : ""}`),
      el("span", { role: "cell", class: "mono", "data-k": "settlement" }, link(e.settleUrl, short(e.settleTx))),
      el("span", { role: "cell", class: "mono", "data-k": "$WIF back" }, e.cashbackTx ? link(e.cashbackUrl, short(e.cashbackTx)) : e.cashbackError ? "failed" : "—"),
    )) : [el("li", { class: "empty", role: "row" }, el("span", { role: "cell" }, "No paid calls yet."))]),
  );
  // the board is redrawn every few seconds: keep a worker's half-typed answer, the focus and the selection in it
  const drafts = new Map([...document.querySelectorAll("#tasks input[data-task]")].map((i) => [i.dataset.task, i.value]));
  const active = document.activeElement?.closest?.("#tasks") ? document.activeElement : null;
  const focused = active?.dataset.task;
  const selection = active ? [active.selectionStart, active.selectionEnd] : null;
  $("#tasks").replaceChildren(
    ...(tasks.length ? tasks.map((t) => taskItem(t, drafts)) : [el("li", { class: "empty" }, "No tasks yet. Hire a human above.")]),
  );
  if (focused) {
    const input = [...document.querySelectorAll("#tasks input[data-task]")].find((i) => i.dataset.task === focused);
    if (input) {
      input.focus();
      input.setSelectionRange(selection[0] ?? input.value.length, selection[1] ?? input.value.length);
    }
  }
}

await loadInfo();
await refresh();
setInterval(refresh, 4000);
