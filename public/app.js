import { paymentHeader, typedDataFor, walletPayBlocked } from "/x402-browser.js";

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const k of kids) n.append(k);
  return n;
};
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const link = (href, text) => (href ? el("a", { href, target: "_blank", rel: "noopener" }, text) : document.createTextNode("—"));

let info;

async function loadInfo() {
  info = await (await fetch("/api/info")).json();
  const f = $("#facts");
  f.replaceChildren();
  const add = (k, v) => f.append(el("div", {}, el("dt", {}, k), el("dd", {}, v)));
  add("network", `${info.network.label} · ${info.network.caip2}`);
  add("ask an agent", `${info.prices.ask.standard} USDG · ${info.prices.ask.holder} for holders`);
  add("hire a human", `${info.prices.hire.standard} USDG · ${info.prices.hire.holder} for holders`);
  if (info.wif.token) add("$WIF", `${info.wif.cashback} back per call · holder ≥ ${info.wif.holderMin}`);
  add("paid to", link(info.payToUrl, short(info.payTo)));
  add("facilitator", info.facilitator.replace(/^https?:\/\//, ""));
  document.querySelectorAll("[data-price]").forEach((n) => (n.textContent = info.prices[n.dataset.price].standard));
  document.querySelectorAll("[data-origin]").forEach((n) => (n.textContent = location.origin));
  document.querySelectorAll("[data-caip2]").forEach((n) => (n.textContent = info.network.caip2));
  const blocked = walletPayBlocked(info);
  for (const b of [$("#ask-pay"), $("#hire-pay")]) {
    b.disabled = !!blocked;
    if (blocked) b.title = blocked;
  }
  if (blocked) show($("#ask-out"), blocked);
}

function show(out, value, bad = false) {
  out.hidden = false;
  out.classList.toggle("bad", bad);
  out.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function wallet() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No browser wallet found. Use the terminal flow below (npm run buy).");
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

/** 402 -> sign in the wallet -> retry with X-PAYMENT */
async function payAndCall(path, body, out, button) {
  const blocked = walletPayBlocked(info);
  if (blocked) return show(out, blocked, true);
  button.disabled = true;
  try {
    const { eth, from } = await wallet();
    const init = { method: "POST", headers: { "content-type": "application/json", "x-payer": from }, body: JSON.stringify(body) };
    const first = await fetch(path, init);
    if (first.status !== 402) return show(out, await first.json(), !first.ok);
    const terms = await first.json();
    const accept = terms.accepts[0];
    show(out, `Sign ${Number(accept.amount) / 1e6} USDG to ${short(accept.payTo)} in your wallet…`);
    const typed = typedDataFor(accept, from);
    const signature = await eth.request({ method: "eth_signTypedData_v4", params: [from, JSON.stringify({ ...typed, types: { EIP712Domain: [
      { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
    ], ...typed.types } })] });
    show(out, "Settling on Robinhood Chain…");
    const paid = await fetch(path, { ...init, headers: { ...init.headers, "X-PAYMENT": paymentHeader(accept, typed, signature) } });
    show(out, await paid.json(), !paid.ok);
    refresh();
  } catch (e) {
    show(out, e.message || String(e), true);
  } finally {
    button.disabled = false;
  }
}

$("#ask-quote").onclick = async () => {
  const r = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: $("#question").value }) });
  show($("#ask-out"), { status: r.status, body: await r.json() }, r.status !== 402);
};
$("#ask-pay").onclick = (e) => payAndCall("/api/ask", { question: $("#question").value }, $("#ask-out"), e.currentTarget);
$("#hire-pay").onclick = (e) => payAndCall("/api/hire", { request: $("#request").value }, $("#hire-out"), e.currentTarget);

async function taskAction(id, action, extra = {}) {
  const r = await fetch(`/api/tasks/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-token": $("#worker-token").value },
    body: JSON.stringify({ worker: $("#worker").value.trim(), ...extra }),
  });
  if (!r.ok) alert((await r.json()).error);
  refresh();
}

async function refresh() {
  const [ledger, tasks] = await Promise.all([(await fetch("/api/ledger")).json(), (await fetch("/api/tasks")).json()]);
  $("#ledger tbody").replaceChildren(
    ...(ledger.length ? ledger.map((e) => el("tr", {},
      el("td", {}, new Date(e.at).toLocaleTimeString()),
      el("td", {}, e.kind === "ask" ? "ask" : `hire #${e.taskId}`),
      el("td", { class: "mono" }, short(e.payer)),
      el("td", {}, `${e.price} USDG${e.tier === "holder" ? " (holder)" : ""}`),
      el("td", { class: "mono" }, link(e.settleUrl, short(e.settleTx))),
      el("td", { class: "mono" }, e.cashbackTx ? link(e.cashbackUrl, short(e.cashbackTx)) : e.cashbackError ? "failed" : "—"),
    )) : [el("tr", {}, el("td", { colspan: "6", class: "muted" }, "No paid calls yet."))]),
  );
  $("#tasks").replaceChildren(
    ...(tasks.length ? tasks.map((t) => {
      const li = el("li", {}, el("span", { class: "badge" }, t.status), t.request,
        el("div", { class: "meta" }, `#${t.id} · paid by ${short(t.payer)} · `, link(t.paidTx && info ? `${info.network.explorer}/tx/${t.paidTx}` : null, "payment")));
      if (t.answer) li.append(el("p", { class: "answer" }, t.answer));
      if (t.status === "open") {
        const b = el("button", { class: "ghost" }, "claim");
        b.onclick = () => taskAction(t.id, "claim");
        li.append(el("div", { class: "row" }, b));
      } else if (t.status === "claimed") {
        const input = el("input", { placeholder: "your answer" });
        const b = el("button", {}, "complete");
        b.onclick = () => taskAction(t.id, "complete", { answer: input.value });
        li.append(el("div", { class: "row" }, input, b));
      }
      return li;
    }) : [el("li", { class: "muted" }, "No tasks yet. Hire a human above.")]),
  );
}

await loadInfo();
await refresh();
setInterval(refresh, 4000);
