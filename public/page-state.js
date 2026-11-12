// What the landing page says, from GET /api/info. Plain ES module with no dependencies, shared with the tests
// (test/page.test.ts): the page must never claim an escrow that does not run.

/** the value at a dotted path of /api/info ("prices.hire.standard"), or undefined */
export function valueAt(info, path) {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), info);
}

/** a value the page should not mention: missing, empty, or an amount of zero ("0", "0.0") */
export function isAbsent(v) {
  return v == null || v === "" || /^0*(\.0*)?$/.test(String(v));
}

/**
 * A USDG amount as /api/info sends it ("0.5", "0.125") with at least two decimals and never fewer than it has:
 * "0.5" -> "0.50", "0.125" -> "0.125". Rounding would show a price the 402 does not ask.
 */
export function usdg(v) {
  const [whole, frac = ""] = String(v).split(".");
  return `${whole}.${frac.replace(/0+$/, "").padEnd(2, "0")}`;
}

/** a token amount as GET /api/proof sends it ("140.0", "0.6") with no trailing zeros: "140", "0.6" */
export function plain(v) {
  const [whole, frac = ""] = String(v).split(".");
  const f = frac.replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

/** "2026-11-12T03:14:35Z" -> "12 Nov 2026, 03:14 UTC"; anything else as it came */
export function utcDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}, ${m[4]}:${m[5]} UTC` : String(iso);
}

/**
 * What the proof strip shows, from GET /api/proof. A figure is shown only when it was read: with the dated read on
 * chain, or with at least one settlement of this server since it started. Otherwise every figure is "—" and the note
 * says why; never a 0 that reads as "nothing happened".
 */
export function proofCopy(p) {
  const read = !!p && (!!p.snapshot || (p.paidCalls?.count ?? 0) > 0 || (p.wif?.count ?? 0) > 0 || (p.escrows?.count ?? 0) > 0);
  if (!read) {
    return {
      read: false,
      calls: "—",
      usdg: "—",
      wif: "—",
      wifSub: "cashback and worker rewards",
      escrows: "—",
      escrowSub: "through Execution Market",
      note: p ? "Nothing on chain to show for this server yet: no dated read for its wallet, and no call settled since it started." : "The transactions could not be read right now.",
    };
  }
  const since = p.serverSince ? utcDate(p.serverSince) : null;
  const note = p.snapshot
    ? `Read on Robinhood Chain on ${utcDate(p.snapshot.readAt)} (block ${Number(p.snapshot.block).toLocaleString("en-US")}), plus every call this server settled since ${since}. Up to that read, every payer was a wallet of the team.`
    : `Every call this server settled since ${since}.`;
  return {
    read: true,
    calls: String(p.paidCalls.count),
    usdg: usdg(p.paidCalls.amount),
    wif: plain(p.wif.amount),
    wifSub: `${p.wif.cashback.count} cashback · ${p.wif.rewards.count} to workers`,
    escrows: String(p.escrows.count),
    escrowSub: p.escrows.count ? `${usdg(p.escrows.amount)} USDG escrowed, then released` : "through Execution Market",
    note,
  };
}

/** what the page says while a server that hires through Execution Market is not taking hires, when it sends no reason */
export const PAUSED_FALLBACK = "this server is not taking hires right now.";

/**
 * The escrow status of a hire. Escrow is on only when the server hires through Execution Market
 * (`hire.via === "execution-market"`, EM_HIRE=on); anything else, a missing `hire` included, is Flat Fee's own task
 * board, with no escrow. index.html carries the "off" strings as its static default. Through Execution Market, the
 * page says "Live" only while the server says a hire would be taken now (`hire.available === true`); otherwise it is
 * paused, with the server's own reason (`hire.paused.reason`) word for word.
 */
export function escrowCopy(info) {
  const hire = info?.hire;
  if (hire?.via !== "execution-market") {
    return {
      escrow: "off",
      pill: "Off on this demo",
      statusLabel: "Today, without escrow:",
      statusText: "your task goes on the task board below, for a person to answer.",
      bounty: null,
      foot: "Waiting for Execution Market's escrow on Robinhood Chain.",
      boardMeta: "for workers: claim and answer",
      boardHow: "Workers: enter your wallet and worker token, claim a task, send the answer.",
      expiry: null,
    };
  }
  const label = info?.network?.label || "Robinhood Chain";
  const deadline = isAbsent(hire.deadlineHours) ? "" : ` Deadline ${hire.deadlineHours} h.`;
  const common = {
    bounty: isAbsent(hire.bounty) ? null : usdg(hire.bounty),
    foot: `Escrow on ${label}.${deadline}`,
    boardMeta: "tasks on Execution Market",
    boardHow: "Tasks hired through Execution Market, and where each one stands. People take them on Execution Market.",
    // what becomes of a hire nobody finishes, in the server's words (hire.expiry); nothing when it sends none
    expiry: typeof hire.expiry === "string" && hire.expiry.trim() ? hire.expiry.trim() : null,
  };
  if (hire.available !== true) {
    const reason = hire.paused?.reason;
    return {
      escrow: "paused",
      pill: "Paused on this demo",
      statusLabel: "Hiring is paused:",
      statusText: typeof reason === "string" && reason.trim() ? reason.trim() : PAUSED_FALLBACK,
      ...common,
    };
  }
  return {
    escrow: "on",
    pill: "Live on this demo",
    statusLabel: "With escrow:",
    statusText: "your task goes to Execution Market, and answers show on the task board below.",
    ...common,
  };
}
