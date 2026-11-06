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

/**
 * The escrow status of a hire. Escrow is on only when the server hires through Execution Market
 * (`hire.via === "execution-market"`, EM_HIRE=on); anything else, a missing `hire` included, is Flat Fee's own task
 * board, with no escrow. index.html carries the "off" strings as its static default.
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
    };
  }
  const label = info?.network?.label || "Robinhood Chain";
  const deadline = isAbsent(hire.deadlineHours) ? "" : ` Deadline ${hire.deadlineHours} h.`;
  return {
    escrow: "on",
    pill: "Live on this demo",
    statusLabel: "With escrow:",
    statusText: "your task goes to Execution Market, and answers show on the task board below.",
    bounty: isAbsent(hire.bounty) ? null : usdg(hire.bounty),
    foot: `Escrow on ${label}.${deadline}`,
    boardMeta: "tasks on Execution Market",
    boardHow: "Tasks hired through Execution Market, and where each one stands. People take them on Execution Market.",
  };
}
