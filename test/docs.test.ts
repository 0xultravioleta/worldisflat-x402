// What README.md and SUBMISSION.md say about the first hire through Execution Market on Robinhood Chain mainnet,
// checked against the run's own output (docs/evidence/e2e-hire-2026-11-07.txt: what `npm run e2e:hire` printed,
// unchanged, and its exit code) and against the deploy's settings (deploy/aws/em-hire.env, read as the server reads
// it): every transaction hash, the amounts and the direction written next to each one and no other amount, the end
// balances, the Execution Market task, the wallets and the prices. Also the owner's sentence that the worker is a team
// test wallet and not a person, the server's own words for a hire nobody takes (hireExpiry, as GET /api/info serves
// it), the merchant's identity, and the lengths SUBMISSION.md gives for the texts to paste in the form. And the team:
// the owner's X in both docs and in the kit, no [SAUL_…] or [C0DER_…] placeholder in either doc, and no full name or
// prize wallet in this public repo (the owner types them in the form). No network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Wallet, formatUnits } from "ethers";
import { loadConfig } from "../src/config.js";
import { hireExpiry } from "../src/emhire.js";

const README = readFileSync("README.md", "utf8");
const SUBMISSION = readFileSync("SUBMISSION.md", "utf8");
const EM_DOC = readFileSync("docs/EXECUTION-MARKET.md", "utf8");
const LOG = readFileSync("docs/evidence/e2e-hire-2026-11-07.txt", "utf8");
const KIT_README = readFileSync("docs/kit/README-draft.md", "utf8");
const KIT_FORM = readFileSync("docs/kit/form-fields.md", "utf8");
const KIT_CLICKS = readFileSync("docs/kit/00-CLICKS.md", "utf8");
/** every file of the kit for the form, by name */
const KIT = new Map(readdirSync("docs/kit").filter((f) => f.endsWith(".md")).map((f) => [f, readFileSync(`docs/kit/${f}`, "utf8")]));

/** KEY=VALUE lines of the deploy's settings, comments and blank lines skipped */
function envFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
// the live demo's settings; the two secrets the container holds are stood in for
const CFG = loadConfig({ ...envFile("deploy/aws/em-hire.env"), MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey, WORKER_TOKEN: "a-worker-token-of-16+" });
assert.ok(CFG.em, "the deploy's settings hire through Execution Market");
const EM = CFG.em;

type TxKey = "settle" | "cashback" | "escrow" | "payment" | "reward";
interface Report {
  ok: boolean;
  problems: string[];
  emTaskId: string;
  txs: Record<TxKey, string>;
  seen: { at: string; source: string; what: string; tx?: string }[];
  deltas: Record<"payerUsdg" | "payToUsdg" | "merchantUsdg" | "workerUsdg" | "workerWif" | "payerWif", string>;
}

/** the JSON report the run prints after its timeline: from the line "{" to the line "}" */
function report(log: string): Report {
  const start = log.indexOf("\n{\n");
  const end = log.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, "the run's JSON report is in the evidence");
  return JSON.parse(log.slice(start + 1, end + 2));
}

const RUN = report(LOG);
/** the run's second line: who pays what, what the merchant locks for whom */
const HEAD = /^buyer (0x[0-9a-fA-F]{40}) pays (\d+\.\d+) USDG; the merchant locks (\d+\.\d+) USDG for the worker (0x[0-9a-fA-F]{40}) /m.exec(LOG);
assert.ok(HEAD, "the run's second line names the buyer, the price, the bounty and the worker");
const [, BUYER, PRICE, BOUNTY, WORKER] = HEAD;
const FEE = /^\S+ +chain +EM fee (\d+)%: /m.exec(LOG)?.[1];
assert.ok(FEE, "the run names Execution Market's fee");

/** an atomic amount as the docs write it: 10, 0.25, 0.174 (no trailing .0) */
function amount(atomic: string | bigint, decimals: number): string {
  return formatUnits(BigInt(atomic), decimals).replace(/\.0$/, "");
}
const usdg = (a: string | bigint) => amount(a, 6);
const wif = (a: string | bigint) => amount(a, 18);
const twoDecimals = (atomic: bigint) => Number(formatUnits(atomic, 6)).toFixed(2);

/** the amounts the text next to each transaction must say, and the only numbers it may say, all of them from the run */
const MUST: Record<TxKey, string[]> = {
  settle: [`${usdg(-BigInt(RUN.deltas.payerUsdg))} USDG`],
  cashback: [`${wif(RUN.deltas.payerWif)} $WIF`],
  escrow: [`${BOUNTY} USDG`],
  payment: [`${usdg(RUN.deltas.workerUsdg)} USDG`, `${FEE}% fee`],
  reward: [`${wif(RUN.deltas.workerWif)} $WIF`],
};
/** each as `<number> <token>` (USDG, $WIF, % or nothing): 10 USDG is not the 10 $WIF of the cashback */
const MAY: Record<TxKey, string[]> = {
  settle: [`${Number(PRICE)} USDG`],
  cashback: [`${Number(wif(RUN.deltas.payerWif))} $WIF`],
  escrow: [`${Number(BOUNTY)} USDG`],
  payment: [`${Number(usdg(RUN.deltas.workerUsdg))} USDG`, `${Number(BOUNTY)} `, `${Number(FEE)} %`],
  reward: [`${Number(wif(RUN.deltas.workerWif))} $WIF`],
};
/** who paid whom, in each set of texts that cites the run */
const README_WAY: Record<TxKey, string> = {
  settle: "buyer → merchant",
  cashback: "merchant → buyer",
  escrow: "merchant → Execution Market's escrow",
  payment: "to the worker",
  reward: "merchant → worker",
};
const FORM_TX_WAY: Record<TxKey, string> = {
  settle: "payer to merchant",
  cashback: "to the payer",
  escrow: "by the merchant",
  payment: "released to the test worker",
  reward: "to the test worker",
};
const FORM_ACC_WAY: Record<TxKey, string> = {
  settle: "the team's payer wallet paid",
  cashback: "the buyer",
  escrow: "the merchant locked",
  payment: "paid the worker",
  reward: "sent the worker",
};
const KEY_OF = new Map(Object.entries(RUN.txs).map(([k, h]) => [h, k as TxKey]));
/** the 2 Nov paid question (README, "A paid question"): the only other Robinhood Chain transactions the docs cite */
const EARLIER = new Set([
  "0x432e381183277e5f6b485adb0e4ff2cb072b59b38c80246c1b21efa99c446f33",
  "0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640",
]);
/**
 * The merchant's ERC-8004 identity on Base, which is not in the run's output: Execution Market's public
 * GET /api/v1/reputation/register/wallet/<merchant>?network=base answered agent_id 1170265 on 7 Nov 2026; on Base the
 * facilitator minted token 1170265 to itself (mint) and transferred it to the merchant (transfer).
 */
const IDENTITY = {
  agent: "1170265",
  mint: "https://basescan.org/tx/0x53234d1747e29f3fb73b7bb1a06e2dce77bcdd2cfde54b8f7348389fb46682c8",
  transfer: "https://basescan.org/tx/0xf79f1e26efa7d1da49a7b46067200f7b93c4ef7a5b34041b3bb79c0e39fb74a6",
};
/** the owner's sentence (2026-11-07): who the worker of this run is. Backticks and bold are dropped before comparing */
const TEST_WORKER =
  "The worker in this run is a test wallet of the team, driven by a script, that declares itself to Execution Market " +
  "as a PayBox client (human_via_agent); it is not a person and not a real customer.";
const TEAM_BUYER = "the team's payer wallet";
const WHO = String.raw`\b(?:(?:a|the|one|real|some) (?:human|person|people|tasker)|someone|somebody)(?: \S+){0,5}?`;
const PERSON_DID_IT = new RegExp(`${WHO} (?:took|takes|applied|applies|delivered|delivers|completed|completes|did|does)\\b`, "i");
const PERSON_DID_IT_PAST = new RegExp(`${WHO} (?:took|applied|delivered|completed|did|was paid|got paid)\\b`, "i");
/** what each link to the hire says next to it, word for word */
const NEXT_TO_LINK = "team test wallet driven by a script, not a person";
const EXPIRY = hireExpiry(EM.deadlineHours);

const TX = /https:\/\/robinhoodchain\.blockscout\.com\/tx\/(0x[0-9a-fA-F]+)/g;
const norm = (s: string) => s.replace(/\*\*|`/g, "").replace(/\s+/g, " ");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `want` as a whole amount: 0.25 USDG is not found inside 10.25 USDG */
const has = (text: string, want: string) => new RegExp(`(?<![\\d.])${esc(want)}`).test(norm(text));
/** every amount a text says, as `<number> <token>` (dates and words like x402 left out) */
const amounts = (text: string) =>
  [...norm(text).replace(/\b\d{1,2} Nov \d{4}\b/g, "").matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?!\w)( ?(USDG|\$WIF)\b|%)?/g)].map(
    (m) => `${Number(m[1])} ${m[3] ?? (m[2] === "%" ? "%" : "")}`,
  );

/** a heading's section, up to the next heading of the same level or above */
function section(doc: string, heading: string): string {
  const at = doc.indexOf(`\n${heading}\n`);
  assert.ok(at >= 0, `no heading "${heading}"`);
  const level = /^#+/.exec(heading)![0].length;
  const rest = doc.slice(at + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next < 0 ? rest : rest.slice(0, next);
}

/** SUBMISSION's edit section: each text to paste, by the label line written above its block */
const EDIT = section(SUBMISSION, "## Edit before 12 Nov 2026, 17:30 UTC: hiring through Execution Market (ready to paste)");
function blocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/(?:^|\n)([^\n]+):\n\n```text\n([\s\S]*?)\n```/g)) {
    assert.ok(!out.has(m[1]), `two blocks labelled ${m[1]}`);
    out.set(m[1], m[2]);
  }
  return out;
}
const BLOCKS = blocks(EDIT);
function block(label: string): string {
  const b = BLOCKS.get(label);
  assert.ok(b !== undefined, `SUBMISSION.md has no block "${label}"`);
  return b;
}
const EM_SECTION = section(README, "## Hiring a human through Execution Market");
const HIRE = section(README, "### A hire through Execution Market (7 Nov 2026)");
// the edit section's own paragraph, above its table (the blocks below it carry the sentence too)
const INTRO = EDIT.slice(0, EDIT.indexOf("\n| field |"));
const TX_BLOCK = block("*Transactions*, added after the two lines already there");
const WALLET_BLOCK = block("*Wallets*, added after the two lines already there");
const ACC_BLOCK = block("Long story, *Accomplishments*, added after the paragraph already there");
const WHAT_BLOCK = block("Long story, *What it does*");

/**
 * Every transaction link in `units` is one of the run's; the text between it and the link before it (in the same unit:
 * a table row, a line, a paragraph) says that transaction's amounts and who paid whom, and no number the run does not
 * give for it; and every transaction of the run is there.
 */
function citesTheRun(where: string, units: string[], way: Record<TxKey, string>) {
  const cited = new Set<TxKey>();
  for (const unit of units) {
    let from = 0;
    for (const m of unit.matchAll(TX)) {
      const key = KEY_OF.get(m[1]);
      assert.ok(key, `${where}: ${m[1]} is not a transaction of the run`);
      const before = unit.slice(from, m.index);
      for (const want of MUST[key]) assert.ok(has(before, want), `${where}: next to the ${key} transaction it should say "${want}": ${before}`);
      assert.ok(norm(before).includes(way[key]), `${where}: next to the ${key} transaction it should say "${way[key]}": ${before}`);
      assert.ok((before.match(/→/g) ?? []).length <= 1, `${where}: one direction next to the ${key} transaction: ${before}`);
      for (const a of amounts(before)) assert.ok(MAY[key].includes(a), `${where}: "${a}" next to the ${key} transaction is not the run's: ${before}`);
      from = m.index! + m[0].length;
      cited.add(key);
    }
    // after the last link of a unit, no amount at all
    assert.deepEqual(amounts(unit.slice(from)), [], `${where}: an amount after the last transaction: ${unit.slice(from)}`);
  }
  assert.deepEqual([...cited].sort(), Object.keys(RUN.txs).sort(), `${where}: every transaction of the run`);
}

test("the evidence is a run that passed: ok, no problems, PASS, exit 0, all five transactions", () => {
  assert.equal(RUN.ok, true);
  assert.deepEqual(RUN.problems, []);
  assert.match(LOG, new RegExp(`^PASS +hire \\S+ \\(EM ${esc(RUN.emTaskId)}\\)`, "m"));
  assert.match(LOG, /^rc=0$/m);
  assert.deepEqual(Object.keys(RUN.txs).sort(), ["cashback", "escrow", "payment", "reward", "settle"]);
  for (const h of Object.values(RUN.txs)) assert.match(h, /^0x[0-9a-f]{64}$/);
  // its numbers hold together: the price is what the buyer lost, the worker got the bounty less the fee, and the
  // merchant kept the price less the bounty
  const micro = (s: string) => BigInt(s.replace(".", "").replace(/^0+/, "")) * 10n ** BigInt(6 - s.split(".")[1].length);
  assert.equal(-BigInt(RUN.deltas.payerUsdg), micro(PRICE));
  assert.equal(BigInt(RUN.deltas.workerUsdg), (micro(BOUNTY) * (100n - BigInt(FEE))) / 100n);
  assert.equal(BigInt(RUN.deltas.merchantUsdg), micro(PRICE) - micro(BOUNTY));
  // and with the deploy's settings: the buyer paid the holder price of a hire, the bounty is EM_BOUNTY_USDG, and the
  // rewards are the configured ones
  assert.equal(micro(PRICE), CFG.prices.hireHolder);
  assert.equal(micro(BOUNTY), EM.bounty);
  assert.equal(BigInt(RUN.deltas.payerWif), CFG.wif.cashback);
  assert.equal(BigInt(RUN.deltas.workerWif), CFG.wif.workerReward);
});

test("README: each row of the hire's table is a transaction of the run, with its own amounts and direction", () => {
  const rows = HIRE.split("\n").filter((l) => l.startsWith("| ") && /blockscout\.com\/tx\//.test(l));
  citesTheRun("README", rows, README_WAY);
  // the short label of each link is its own hash
  for (const m of HIRE.matchAll(/\[(0x[0-9a-f]{4})…([0-9a-f]{4})\]\(https:\/\/robinhoodchain\.blockscout\.com\/tx\/(0x[0-9a-f]{64})\)/g)) {
    assert.equal(m[1] + m[2], m[3].slice(0, 6) + m[3].slice(-4), `the label of ${m[3]}`);
  }
  assert.equal([...HIRE.matchAll(/\[0x[0-9a-f]{4}…[0-9a-f]{4}\]\(/g)].length, 5, "five labelled links");
});

test("SUBMISSION: the Transactions lines and the Accomplishments paragraph cite the run, each amount by its hash", () => {
  citesTheRun("SUBMISSION, Transactions", TX_BLOCK.split("\n"), FORM_TX_WAY);
  citesTheRun("SUBMISSION, Accomplishments", [ACC_BLOCK], FORM_ACC_WAY);
});

test("every transaction both docs link to is the run's, the 2 Nov question's or the identity's, hash for hash", () => {
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    const links = [...doc.matchAll(TX)].map((m) => m[1]);
    assert.ok(links.length > 0);
    for (const h of links) assert.ok(KEY_OF.has(h) || EARLIER.has(h), `${name} links to ${h}, a transaction of no run on record`);
    for (const m of doc.matchAll(/https:\/\/basescan\.org\/tx\/0x[0-9a-fA-F]+/g)) {
      assert.ok([IDENTITY.mint, IDENTITY.transfer].includes(m[0]), `${name} links to ${m[0]}`);
    }
  }
});

test("the end balances, the time, the Execution Market task and the wallets are the run's", () => {
  const d = RUN.deltas;
  const balances =
    `the buyer -${usdg(-BigInt(d.payerUsdg))} USDG and +${wif(d.payerWif)} $WIF, the worker +${usdg(d.workerUsdg)} USDG and ` +
    `+${wif(d.workerWif)} $WIF, and the merchant +${usdg(d.merchantUsdg)} USDG (the ${PRICE} it was paid, less the ${BOUNTY} it locked)`;
  assert.ok(norm(HIRE).includes(balances), `README says: ${balances}`);
  const hhmm = (at: string) => at.slice(11, 16);
  assert.ok(RUN.seen.length > 0 && RUN.seen.every((s) => s.at.startsWith("2026-11-07T")));
  assert.ok(norm(HIRE).includes(`on 7 Nov 2026 from ${hhmm(RUN.seen[0].at)} to ${hhmm(RUN.seen.at(-1)!.at)} UTC`));
  // the task id: the only UUID either doc names
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    const ids = [...doc.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0]);
    assert.ok(ids.length > 0 && ids.every((id) => id === RUN.emTaskId), `${name} names the task ${RUN.emTaskId} and no other`);
  }
  assert.ok(HIRE.includes(`https://api.execution.market/api/v1/tasks/${RUN.emTaskId}`));
  assert.ok(TX_BLOCK.includes(`https://api.execution.market/api/v1/tasks/${RUN.emTaskId}`));
  // the test worker and the buyer, as the run named them; the buyer is the team's own wallet wherever the run is cited
  assert.match(norm(HIRE), new RegExp(`test worker ${WORKER} \\(a team wallet, not a person\\)`));
  assert.match(WALLET_BLOCK, new RegExp(`^Test worker \\(a team wallet driven by a script, not a person\\): ${WORKER}$`, "m"));
  assert.ok(norm(HIRE).includes(`buyer ${BUYER}`));
  for (const [name, text] of [["README, the hire", HIRE], ["SUBMISSION, the edit section's paragraph", INTRO], ["SUBMISSION, Transactions", TX_BLOCK], ["SUBMISSION, Accomplishments", ACC_BLOCK]]) {
    assert.ok(norm(text).toLowerCase().includes(TEAM_BUYER), `${name} says the buyer is ${TEAM_BUYER}`);
  }
});

test("the prices, the bounty and the deadline the README gives are the deploy's", () => {
  assert.ok(norm(README).includes(`A hire paid there (${twoDecimals(CFG.prices.hire)} USDG, ${twoDecimals(CFG.prices.hireHolder)} for $WIF holders)`));
  assert.ok(norm(README).includes(`for any of its people to take within ${EM.deadlineHours} hours`));
  // as GET /api/info writes them
  assert.ok(norm(EM_SECTION).includes(`with the bounty (${formatUnits(EM.bounty, 6)} USDG), the deadline (${EM.deadlineHours} hours)`));
});

test("the merchant's ERC-8004 identity: both docs name the agent, the mint and the transfer to the merchant", () => {
  for (const [name, text, said] of [
    ["README.md", EM_SECTION, "then transferred it to the merchant"],
    ["SUBMISSION.md", WALLET_BLOCK, "and transferred to the merchant"],
  ]) {
    assert.ok(text.includes(IDENTITY.mint) && text.includes(IDENTITY.transfer), `${name} links the mint and the transfer`);
    assert.ok(text.indexOf(IDENTITY.mint) < text.indexOf(IDENTITY.transfer), `${name}: the mint, then the transfer`);
    assert.match(norm(text), new RegExp(`agent ${IDENTITY.agent}\\b`), `${name} names agent ${IDENTITY.agent}`);
    assert.ok(norm(text).includes(said), `${name} says: ${said}`);
  }
});

test("every text that cites the run says the worker is a team test wallet, not a person; none says a person did it", () => {
  for (const [name, text] of [
    ["README, the hire", HIRE],
    ["SUBMISSION, the edit section's paragraph", INTRO],
    ["SUBMISSION, Transactions", TX_BLOCK],
    ["SUBMISSION, Accomplishments", ACC_BLOCK],
  ]) {
    assert.ok(text.trim().length > 0 && norm(text).includes(TEST_WORKER), `${name} says: ${TEST_WORKER}`);
  }
  assert.ok(norm(HIRE).includes("No person took this task"), "README's hire says no person took it");
  // the server's own words on a hire nobody takes are about any hire, so they are left out of this one
  for (const [name, text] of [["README, the hire", HIRE], ["SUBMISSION, the edit section", EDIT]]) {
    assert.doesNotMatch(norm(text).replace(EXPIRY, ""), PERSON_DID_IT, name);
  }
  // nowhere in either doc, in the past tense, does a person do a task: the only hire on record had none. The present
  // tense stays for the flow itself ("A human applies", what Execution Market's people do), with the links below
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    assert.doesNotMatch(norm(doc).replace(EXPIRY, ""), PERSON_DID_IT_PAST, name);
  }
  // and every link to the hire, from anywhere, says so next to it
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION], ["docs/EXECUTION-MARKET.md", EM_DOC]]) {
    let at = doc.indexOf("#a-hire-through-execution-market-7-nov-2026");
    assert.ok(at >= 0, `${name} links to the hire`);
    for (; at >= 0; at = doc.indexOf("#a-hire-through-execution-market-7-nov-2026", at + 1)) {
      const next = norm(doc.slice(at, at + 400));
      assert.ok(next.includes(NEXT_TO_LINK) || next.includes(TEST_WORKER), `${name}: the link to the hire at ${at} says: ${NEXT_TO_LINK}`);
    }
  }
});

test("a hire nobody takes: both docs quote the server's own words, the fee not refunded included", () => {
  assert.match(EXPIRY, /the fee you paid is not refunded/);
  assert.ok(EM_SECTION.includes(`> ${EXPIRY}\n`), "README quotes it");
  assert.ok(WHAT_BLOCK.includes(`"${EXPIRY}"`), "SUBMISSION's long story quotes it");
});

test("SUBMISSION: the length given for each text to paste is its length", () => {
  const rows = [...EDIT.matchAll(/^\| ([^|]+?) \| ([^|]+?) \| (\d+) chars/gm)];
  assert.ok(rows.length >= 10, "the table of fields");
  const plain = (s: string) => s.replace(/\*/g, "");
  for (const [, field, cell, n] of rows) {
    let text: string;
    if (field === "One liner") {
      text = /^`(.+)`$/.exec(cell)![1];
    } else {
      const labels = [...BLOCKS.keys()].filter((l) => plain(l).startsWith(plain(field)));
      assert.equal(labels.length, 1, `one block for "${field}": ${labels.join(" / ")}`);
      text = BLOCKS.get(labels[0])!;
    }
    assert.equal([...text].length, Number(n), `${field}: ${n} chars`);
  }
});

test("the team: the owner's X and c0der in both docs and the kit; no [SAUL_…] or [C0DER_…] placeholder but the full name and the prize wallet, which only the form gets", () => {
  const X = "[@0xultravioleta](https://x.com/0xultravioleta)";
  assert.ok(section(README, "## Team").includes(`Saúl (${X}) and c0der.`), `README's team links ${X}`);
  assert.ok(section(KIT_README, "## Team").includes(`Saúl (${X}) and c0der.`), `the kit's README draft links ${X}`);
  // SUBMISSION's team section, whole: its note, then the block pasted in the form line for line (the lead's handle and
  // nothing after it, c0der by its name), and no address anywhere in it: no full name, no prize wallet
  const team = section(SUBMISSION, "## 1. Your team");
  const NOTE = "The lead's full name and the prize wallet are typed in the form by Saúl, never written here: this file is public.";
  const LINES = [
    "Team: Ultravioleta DAO",
    "Lead: Saúl (@0xultravioleta)",
    "Members: add c0der only if Saúl decides. Up to 4 people; each person can be on one team only.",
  ].join("\n");
  assert.doesNotMatch(team, /0x[0-9a-fA-F]{40}/, "SUBMISSION's team section: an address");
  const pasted = /^```text\n([\s\S]*?)\n```$/m.exec(team);
  assert.ok(pasted, "SUBMISSION's team section has its block");
  assert.equal(pasted[1], LINES, "SUBMISSION's team block, line for line");
  assert.ok(team.split("\n").includes(NOTE), `SUBMISSION's team section says: ${NOTE}`);
  assert.equal(team.trim(), `${NOTE}\n\n\`\`\`text\n${LINES}\n\`\`\``, "SUBMISSION's team section: the note and the block, nothing else");
  assert.match(KIT_FORM, /^Team \(placeholders\): Saúl \(\[SAUL_FULL_NAME\], @0xultravioleta, lead and submitter\) · c0der \(engineering; /m);
  // a person's placeholder: Saúl's, with the accent or without it, or c0der's (with a zero or an O)
  const PERSON = /\[(?:SA[UÚ]L|C[0O]DER)_\w*\]/gi;
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    assert.deepEqual(doc.match(PERSON), null, `${name}: no [SAUL_…] or [C0DER_…] placeholder`);
  }
  assert.ok(KIT.size >= 6 && KIT.has("form-fields.md") && KIT.has("00-CLICKS.md"), "the kit's files");
  // the kit keeps two, the ones filled in the form, never in this repo: the full name (in its team line, above) and
  // the wallet, in the very lines pasted in the form; the click list names them too, and no other file of the kit does
  for (const [f, doc] of KIT) {
    const want = f === "form-fields.md" || f === "00-CLICKS.md" ? ["[SAUL_FULL_NAME]", "[SAUL_WALLET_PUBLIC_ADDRESS]"] : [];
    assert.deepEqual([...new Set(doc.match(PERSON) ?? [])].sort(), want, `docs/kit/${f}: its [SAUL_…] and [C0DER_…] placeholders`);
  }
  assert.ok(section(KIT_FORM, "### Form fields").includes("demo link, wallet [SAUL_WALLET_PUBLIC_ADDRESS]."), "the kit keeps the wallet placeholder");
  // form-fields.md's Rule bullet sends those two to the form
  const rule = KIT_FORM.split("\n").filter((l) => l.startsWith("- **Rule:**"));
  assert.equal(rule.length, 1, "form-fields.md has one Rule bullet");
  assert.ok(rule[0].includes("Replace every `[PLACEHOLDER]` first (the full name and the wallet in the form only, see *Team*)."), `form-fields.md's Rule: ${rule[0]}`);
  // and both the form's fields and the click list say so, in the same words
  const FORM_ONLY = "are filled in the form, by Saúl, and never in this repo: it is public.";
  for (const [name, doc] of [["form-fields.md", KIT_FORM], ["00-CLICKS.md", KIT_CLICKS]]) {
    const says = doc.split("\n").filter((l) => l.includes(FORM_ONLY));
    assert.equal(says.length, 1, `${name} says once: ${FORM_ONLY}`);
    for (const p of ["`[SAUL_FULL_NAME]`", "`[SAUL_WALLET_PUBLIC_ADDRESS]`"]) assert.ok(says[0].includes(p), `${name}: ${p} ${FORM_ONLY}`);
  }
  // the click list's whole section, that sentence aside, has no name, wallet, email or handle left to replace
  const CLICKS_FORM_ONLY = "`[SAUL_FULL_NAME]` and `[SAUL_WALLET_PUBLIC_ADDRESS]` " + FORM_ONLY;
  const fill = section(KIT_CLICKS, "## Fill these placeholders first (only Saúl has them)");
  assert.equal(fill.split(CLICKS_FORM_ONLY).length, 2, `the click list says once: ${CLICKS_FORM_ONLY}`);
  const rest = fill.replace(CLICKS_FORM_ONLY, "");
  assert.match(rest, /^Search form-fields\.md for `\[` and replace: /m, "the click list says what to replace");
  assert.doesNotMatch(rest, /name|wallet|e-?mail|handle|personal|address/i, `the click list replaces no name, wallet, email or handle: ${rest}`);
});
