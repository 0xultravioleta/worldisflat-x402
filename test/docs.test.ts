// What README.md and SUBMISSION.md say about the first hire through Execution Market on Robinhood Chain mainnet,
// checked against the run's own output (docs/evidence/e2e-hire-2026-11-07.txt: what `npm run e2e:hire` printed,
// unchanged, and its exit code) and against the deploy's settings (deploy/aws/em-hire.env, read as the server reads
// it): every transaction hash, the amounts and the direction written next to each one and no other amount, the end
// balances, the Execution Market task, the wallets and the prices. Also the owner's sentence that the worker is a team
// test wallet and not a person, the server's own words for a hire nobody takes (hireExpiry, as GET /api/info serves
// it), the merchant's identity, and the demo's own approval and the cap the code puts on it. The texts SUBMISSION.md
// gives for the submission form: one per field of the real form, in its order, each within its field's cap, plain text,
// the transactions as hashes only, and the sentence about the test worker where the run is told; docs/kit maps the same
// fields. And the team: the owner's X in both docs and in the kit, no [SAUL_…] or [C0DER_…] placeholder in either doc,
// and no full name or prize wallet in this public repo (the owner types them in the form). No network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Wallet, formatUnits } from "ethers";
import { loadConfig } from "../src/config.js";
import { MAX_ANSWER_BYTES, hireExpiry } from "../src/emhire.js";

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
// the live demo's settings; the three secrets the container holds are stood in for
const CFG = loadConfig({ ...envFile("deploy/aws/em-hire.env"), MERCHANT_PRIVATE_KEY: Wallet.createRandom().privateKey, WORKER_TOKEN: "a-worker-token-of-16+", RPC_URL: "https://private-rpc.example/robinhood" });
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
const KEY_OF = new Map(Object.entries(RUN.txs).map(([k, h]) => [h, k as TxKey]));
/** the 2 Nov paid question (README, "A paid question"): the only other Robinhood Chain transactions the docs cite */
const EARLIER_TXS = {
  settle: "0x432e381183277e5f6b485adb0e4ff2cb072b59b38c80246c1b21efa99c446f33",
  cashback: "0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640",
};
const EARLIER = new Set(Object.values(EARLIER_TXS));
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

/** a heading's anchor as GitHub writes it: lower case, punctuation but hyphens dropped, spaces as hyphens */
const anchor = (heading: string) => heading.replace(/^#+ /, "").toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");

/**
 * The submission form's fields, in its order, as its own script defines them
 * (https://worldisflat.fun/build/assets/js/form.js?v=0d65455f4eb5, read on 8 Nov 2026: SECTIONS, each field's `key`,
 * `kind` and `max`). The cap is the field's maxlength; a choice or a list has none. The browser splits a list at spaces
 * and commas (form.js:828, `input.value.split(/[\s,]+/).filter(Boolean)`).
 */
const FORM: { step: string; key: string; kind: string; cap: number | null }[] = (
  [
    ["your team", "team_name", "text", 60],
    ["your team", "email", "email", 254],
    ["your team", "github_profile", "text", 100],
    ["your team", "contact_handle", "text", 60],
    ["your team", "payout_address", "text", 42],
    ["your project", "name", "text", 60],
    ["your project", "one_liner", "text", 80],
    ["your project", "category_slugs", "categories", null],
    ["your project", "what_it_does", "area", 1500],
    ["your project", "who_its_for", "area", 500],
    ["how it connects to $wif", "wif_usage", "area", 1000],
    ["how it connects to $wif", "integration_types", "multi", null],
    ["how it connects to $wif", "contract_addresses", "list", null],
    ["how it connects to $wif", "ok_to_feature", "check", null],
    ["your flywheel", "flywheel_action", "area", 500],
    ["your flywheel", "flywheel_wif", "area", 500],
    ["your flywheel", "flywheel_return", "area", 500],
    ["proof of build", "repo_url", "url", 300],
    ["proof of build", "demo_video_url", "url", 300],
    ["proof of build", "live_url", "url", 300],
    ["proof of build", "tx_hashes", "list", null],
    ["proof of build", "how_its_made", "area", 1500],
    ["proof of build", "whats_next", "area", 500],
  ] as const
).map(([step, key, kind, cap]) => ({ step, key, kind, cap }));
/** the fields SUBMISSION.md gives an answer for: every one after the team's (the lead fills those) */
const PROJECT_FIELDS = FORM.filter((f) => f.step !== "your team");
const formList = (value: string) => value.split(/[\s,]+/).filter(Boolean);

/** SUBMISSION's section for the form: its intro, then one ### subsection per field (the team's first) */
const FORM_HEADING = "## Form fields (worldisflat.fun, edit submission)";
const FORM_SECTION = section(SUBMISSION, FORM_HEADING);
const [FORM_INTRO, ...SUBSECTIONS] = FORM_SECTION.split(/\n(?=### )/);
const TEAM = SUBSECTIONS[0];
interface Answer {
  label: string;
  key: string;
  /** what the heading says after the key: "<n> of <cap> chars", or what kind of choice or list */
  what: string;
  /** the text blocks under the heading */
  blocks: string[];
}
const ANSWERS: Answer[] = SUBSECTIONS.slice(1).map((s) => {
  const h = /^### ([^\n·]+) · `(\w+)` · ([^\n]+)\n/.exec(s);
  assert.ok(h, `SUBMISSION, the form's section: a field's heading is "### <label> · \`<key>\` · <length>": ${s.split("\n")[0]}`);
  return { label: h[1], key: h[2], what: h[3], blocks: [...s.matchAll(/^```text\n([\s\S]*?)\n```$/gm)].map((m) => m[1]) };
});
/** the one text block SUBMISSION gives for a field of the form */
function answer(key: string): string {
  const a = ANSWERS.find((x) => x.key === key);
  assert.ok(a, `SUBMISSION has no answer for the form's ${key}`);
  assert.equal(a.blocks.length, 1, `SUBMISSION: one block for ${key}`);
  return a.blocks[0];
}
const EM_SECTION = section(README, "## Hiring a human through Execution Market");
const HIRE = section(README, "### A hire through Execution Market (7 Nov 2026)");
const SAFETY = section(README, "## Safety");
const WHAT_IT_DOES = answer("what_it_does");
const HOW_ITS_MADE = answer("how_its_made");
const TX_HASHES = answer("tx_hashes");

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

test("SUBMISSION's answers: every field of the form after the team's, in the form's order, and nothing else", () => {
  assert.ok(FORM_INTRO.trim().length > 0, "the section opens with what it is");
  assert.match(TEAM, /^### your team\n/, "the team's step comes first, as in the form");
  assert.deepEqual(ANSWERS.map((a) => a.key), PROJECT_FIELDS.map((f) => f.key), "one answer per field, in the form's order");
  // the form's own script, as the section names it
  assert.ok(FORM_INTRO.includes("https://worldisflat.fun/build/assets/js/form.js?v=0d65455f4eb5"), "the section names the form's script");
  // and the rest of the file is not a second set of texts to paste
  assert.equal([...SUBMISSION.matchAll(/^```text$/gm)].length, ANSWERS.reduce((n, a) => n + a.blocks.length, 0), "every block of SUBMISSION.md is a field's answer");
});

test("SUBMISSION's answers: each text within its field's cap, its length written right, plain text on one line", () => {
  for (const f of PROJECT_FIELDS) {
    const a = ANSWERS.find((x) => x.key === f.key)!;
    if (f.cap === null) continue;
    const text = answer(f.key);
    // ASCII only and no line break: a cap counted in UTF-16 units, in code points or in bytes is the same number
    assert.match(text, /^[\x20-\x7e]+$/, `${f.key}: printable ASCII on one line`);
    assert.ok(text.length <= f.cap, `${f.key}: ${text.length} chars, above the form's ${f.cap}`);
    assert.equal(a.what, `${text.length} of ${f.cap} chars`, `${f.key}: the heading gives its length and the form's cap`);
    // the form shows text as typed: no markdown, links as bare URLs
    assert.doesNotMatch(text, /\*\*|__|`|\]\(|^[#>*-]|<\/?[a-z]/i, `${f.key}: markdown or HTML`);
  }
  // the choices and the optional list say what to do, with nothing to paste
  for (const f of PROJECT_FIELDS.filter((x) => x.cap === null && x.key !== "tx_hashes")) {
    const a = ANSWERS.find((x) => x.key === f.key)!;
    assert.deepEqual(a.blocks, [], `${f.key}: a choice, no block`);
    assert.match(a.what, /^a (?:choice|tick|list, optional)$/, `${f.key}: what kind of field`);
  }
});

test("SUBMISSION's transactions: only hashes, one per line, the Robinhood Chain ones the README cites", () => {
  const lines = TX_HASHES.split("\n");
  for (const l of lines) assert.match(l, /^0x[0-9a-fA-F]{64}$/, `tx_hashes: "${l}" is not 0x and 64 hex`);
  // the form keeps them as written: splitting at spaces and commas gives the same lines
  assert.deepEqual(formList(TX_HASHES), lines, "tx_hashes: the form's list is the lines");
  assert.equal(new Set(lines).size, lines.length, "tx_hashes: no hash twice");
  // the 2 Nov question's, then the hire's, in the README's order; no Base transaction (the identity's)
  const want = [EARLIER_TXS.settle, EARLIER_TXS.cashback, RUN.txs.settle, RUN.txs.cashback, RUN.txs.escrow, RUN.txs.payment, RUN.txs.reward];
  assert.deepEqual(lines, want, "tx_hashes: the seven, in order");
  const readme = new Set([...README.matchAll(TX)].map((m) => m[1]));
  for (const h of lines) assert.ok(readme.has(h), `tx_hashes: ${h} is a Robinhood Chain transaction the README links to`);
  // and the line under the block names the ones that move $WIF by their place: the second, the fourth and the last
  const nth = ["first", "second", "third", "fourth", "fifth", "sixth"];
  const wifTxs = [EARLIER_TXS.cashback, RUN.txs.cashback, RUN.txs.reward].map((h) => lines.indexOf(h));
  const where = wifTxs.map((i) => (i === lines.length - 1 ? "the last" : `the ${nth[i]}`));
  const said = `Three of them move $WIF: ${where.slice(0, -1).join(", ")} and ${where.at(-1)}.`;
  assert.ok(norm(section(FORM_SECTION, "### transactions · `tx_hashes` · a list, one hash per line")).includes(said), `SUBMISSION says: ${said}`);
});

test("SUBMISSION's answers: the links are the README's, every amount is the deploy's or the run's", () => {
  const top = /^Built for .*Demo video: (\S+) · Live demo: (\S+) ·$/m.exec(README);
  assert.ok(top, "README's links line");
  assert.equal(answer("demo_video_url"), top[1]);
  assert.equal(answer("live_url"), top[2]);
  const repo = /`git clone (\S+) && cd/.exec(README);
  assert.ok(repo, "README's clone line");
  assert.equal(answer("repo_url"), repo[1]);
  for (const k of ["repo_url", "demo_video_url", "live_url"]) assert.match(answer(k), /^https:\/\/\S+$/, k);
  // each `<n> USDG` and `<n> $WIF` of the answers: a price, the bounty, the worker's pay in the run, the cashback, the
  // reward, the holder minimum or the day's budget
  const n = (atomic: bigint, decimals: number) => Number(formatUnits(atomic, decimals));
  const allowed = new Set([
    ...[CFG.prices.ask, CFG.prices.askHolder, CFG.prices.hire, CFG.prices.hireHolder, EM.bounty, BigInt(RUN.deltas.workerUsdg)].map((a) => `${n(a, 6)} USDG`),
    ...[CFG.wif.cashback, CFG.wif.workerReward, CFG.wif.holderMin, CFG.wif.dailyBudget].map((a) => `${n(a, 18)} $WIF`),
  ]);
  for (const a of ANSWERS) {
    for (const b of a.blocks) {
      for (const x of amounts(b).filter((s) => /(USDG|\$WIF)$/.test(s))) assert.ok(allowed.has(x), `${a.key}: "${x}" is not the deploy's or the run's`);
    }
  }
});

test("SUBMISSION's how it's made: the hire of 7 Nov, its worker as the owner wrote it, and the demo's own approval with its cap", () => {
  // the sentence goes where the run is told, which is how it's made (or what it does)
  assert.ok(norm(HOW_ITS_MADE).includes(TEST_WORKER) || norm(WHAT_IT_DOES).includes(TEST_WORKER), `how_its_made or what_it_does says: ${TEST_WORKER}`);
  // every answer that tells the run says it, and says the buyer was the team's
  const tellsTheRun = (b: string) =>
    /\b7 Nov(?:ember)?\b|\bNov(?:ember)?\.? 7\b|\bfirst hire\b|\btest (?:worker|wallet)\b/i.test(b) ||
    b.includes(RUN.emTaskId) ||
    Object.values(RUN.txs).some((h) => b.includes(h)) ||
    has(b, `${usdg(RUN.deltas.workerUsdg)} USDG`);
  // tx_hashes carries only hashes by design (the form splits it): its sentence is the one in how it's made
  const tellers = ANSWERS.filter((a) => a.key !== "tx_hashes" && a.blocks.some(tellsTheRun)).map((a) => a.key);
  assert.ok(tellers.includes("how_its_made"), "how_its_made tells the run");
  for (const k of tellers) {
    assert.ok(norm(answer(k)).includes(TEST_WORKER), `${k} tells the run and says: ${TEST_WORKER}`);
    assert.ok(norm(answer(k)).toLowerCase().includes(TEAM_BUYER), `${k} tells the run and says the buyer is ${TEAM_BUYER}`);
  }
  // the run's numbers, each with what it was
  const d = RUN.deltas;
  for (const said of [
    `the team's payer wallet paid ${usdg(-BigInt(d.payerUsdg))} USDG`,
    `${BOUNTY} USDG went into escrow`,
    `${usdg(d.workerUsdg)} USDG was released to the worker`,
    `${wif(d.workerWif)} $WIF to the worker`,
    `${wif(d.payerWif)} $WIF back to the buyer`,
    `ERC-8004 agent ${IDENTITY.agent} on Base`,
  ]) {
    assert.ok(norm(HOW_ITS_MADE).includes(said), `how_its_made says: ${said}`);
  }
  // the demo approves on its own, and the cap is the code's: what it accepts (src/emhire.ts) and the day's $WIF
  // (WIF_DAILY_BUDGET, enforced in src/wif.ts), in how it's made and in the README's Safety
  assert.match(readFileSync("src/wif.ts", "utf8"), /cfg\.wif\.dailyBudget\)\) throw new Error\("daily \$WIF budget used up \(WIF_DAILY_BUDGET\)"\)/);
  const budget = `${wif(CFG.wif.dailyBudget)} $WIF a UTC day`;
  assert.ok(norm(HOW_ITS_MADE).includes(`the demo approves on its own any text answer of up to ${MAX_ANSWER_BYTES} bytes from the worker it assigned`));
  assert.ok(norm(HOW_ITS_MADE).includes(`caps all the $WIF it sends at ${budget} (WIF_DAILY_BUDGET, src/wif.ts)`), `how_its_made: ${budget}`);
  assert.ok(norm(SAFETY).includes(`Flat Fee approves a delivery on its own, without a person reading it: any text answer of at most ${MAX_ANSWER_BYTES} bytes (MAX_ANSWER_BYTES in src/emhire.ts)`));
  assert.ok(
    norm(SAFETY).includes(
      `at the holder price one such hire costs ${twoDecimals(CFG.prices.hireHolder)} USDG, locks ${twoDecimals(EM.bounty)} USDG in escrow for that wallet, ` +
        `which receives it less Execution Market's fee, and sends out ${wif(CFG.wif.cashback + CFG.wif.workerReward)} $WIF ` +
        `(the ${wif(CFG.wif.cashback)} of the cashback and the ${wif(CFG.wif.workerReward)} of the reward)`,
    ),
    "README's Safety: one such hire, by the deploy's numbers",
  );
  assert.ok(norm(SAFETY).includes(`WIF_DAILY_BUDGET (${budget} for cashback and rewards together`), `README's Safety: ${budget}`);
});

test("every transaction both docs link to is the run's, the 2 Nov question's or the identity's, hash for hash", () => {
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    const links = [...doc.matchAll(TX)].map((m) => m[1]);
    // SUBMISSION gives the form hashes (above), and need link none
    assert.ok(links.length > 0 || doc === SUBMISSION);
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
  assert.ok(norm(FORM_INTRO).includes(`task ${RUN.emTaskId}`), "SUBMISSION's form section names the task");
  // the test worker and the buyer, as the run named them; the buyer is the team's own wallet wherever the run is cited
  assert.match(norm(HIRE), new RegExp(`test worker ${WORKER} \\(a team wallet, not a person\\)`));
  assert.ok(norm(HIRE).includes(`buyer ${BUYER}`));
  for (const [name, text] of [["README, the hire", HIRE], ["SUBMISSION, how it's made", HOW_ITS_MADE]]) {
    assert.ok(norm(text).toLowerCase().includes(TEAM_BUYER), `${name} says the buyer is ${TEAM_BUYER}`);
  }
});

test("the prices, the bounty and the deadline the README gives are the deploy's", () => {
  assert.ok(norm(README).includes(`A hire paid there (${twoDecimals(CFG.prices.hire)} USDG, ${twoDecimals(CFG.prices.hireHolder)} for $WIF holders)`));
  assert.ok(norm(README).includes(`for any of its people to take within ${EM.deadlineHours} hours`));
  // as GET /api/info writes them
  assert.ok(norm(EM_SECTION).includes(`with the bounty (${formatUnits(EM.bounty, 6)} USDG), the deadline (${EM.deadlineHours} hours)`));
});

test("the merchant's ERC-8004 identity: the README names the agent, the mint and the transfer; the form, the agent", () => {
  assert.ok(EM_SECTION.includes(IDENTITY.mint) && EM_SECTION.includes(IDENTITY.transfer), "README links the mint and the transfer");
  assert.ok(EM_SECTION.indexOf(IDENTITY.mint) < EM_SECTION.indexOf(IDENTITY.transfer), "README: the mint, then the transfer");
  assert.ok(norm(EM_SECTION).includes("then transferred it to the merchant"));
  for (const [name, text] of [["README.md", EM_SECTION], ["SUBMISSION, how it's made", HOW_ITS_MADE]]) {
    assert.match(norm(text), new RegExp(`agent ${IDENTITY.agent}\\b`), `${name} names agent ${IDENTITY.agent}`);
  }
});

test("every text that cites the run says the worker is a team test wallet, not a person; none says a person did it", () => {
  for (const [name, text] of [
    ["README, the hire", HIRE],
    ["SUBMISSION, the form section's intro", FORM_INTRO],
    ["SUBMISSION, how it's made", HOW_ITS_MADE],
  ]) {
    assert.ok(text.trim().length > 0 && norm(text).includes(TEST_WORKER), `${name} says: ${TEST_WORKER}`);
  }
  assert.ok(norm(HIRE).includes("No person took this task"), "README's hire says no person took it");
  // the server's own words on a hire nobody takes are about any hire, so they are left out of this one
  for (const [name, text] of [["README, the hire", HIRE], ["SUBMISSION, the form's section", FORM_SECTION]]) {
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
  assert.ok(WHAT_IT_DOES.includes(`"${EXPIRY}"`), "SUBMISSION's what it does quotes it");
});

test("docs/kit: form-fields.md maps the real form, field for field; the click list and it point at SUBMISSION's section; the old drafts say they are outdated", () => {
  const rows = [...KIT_FORM.matchAll(/^\| ([^|]+) \| ([^|]+) \| `(\w+)` \| (\w+) \| ([^|]+) \| ([^|]+) \|$/gm)];
  assert.deepEqual(
    rows.map((r) => [r[1], r[3], r[4], r[5]]),
    FORM.map((f) => [f.step, f.key, f.kind, f.cap === null ? "-" : String(f.cap)]),
    "form-fields.md: every field of the form, with its step, kind and cap",
  );
  assert.equal(rows.find((r) => r[3] === "payout_address")![6], "`[SAUL_WALLET_PUBLIC_ADDRESS]`", "the kit keeps the wallet placeholder");
  // the anchor both use is the heading's
  const link = `../../SUBMISSION.md#${anchor(FORM_HEADING)}`;
  assert.equal(anchor(FORM_HEADING), "form-fields-worldisflatfun-edit-submission");
  for (const [name, doc] of [["form-fields.md", KIT_FORM], ["00-CLICKS.md", KIT_CLICKS]]) {
    assert.ok(doc.includes(`](${link})`), `${name} links to ${link}`);
    // no placeholder left but the two only Saúl fills in
    for (const p of doc.match(/\[[A-Z][A-Z0-9_]*\]/g) ?? []) assert.ok(["[SAUL_FULL_NAME]", "[SAUL_WALLET_PUBLIC_ADDRESS]", "[PLACEHOLDER]"].includes(p), `${name}: ${p}`);
  }
  assert.ok(SUBMISSION.includes(`](#${anchor(FORM_HEADING)})`), "SUBMISSION's header links to its form section");
  // what the owner pastes or reads to paste names no RPC: not the public one, not the variable (c0der, 2026-11-08)
  for (const [name, doc] of [["SUBMISSION.md", SUBMISSION], ...[...KIT].map(([f, d]) => [`docs/kit/${f}`, d])]) {
    assert.doesNotMatch(doc, /rpc/i, `${name} names an RPC`);
  }
  // every other file of the kit opens with the notice that it is outdated
  for (const [f, doc] of KIT) {
    if (f === "form-fields.md" || f === "00-CLICKS.md") continue;
    assert.match(doc, /^> \*\*Outdated\.\*\* /, `docs/kit/${f} says it is outdated`);
  }
});

test("the team: the owner's X and c0der in both docs and the kit; no [SAUL_…] or [C0DER_…] placeholder but the full name and the prize wallet, which only the form gets", () => {
  const X = "[@0xultravioleta](https://x.com/0xultravioleta)";
  assert.ok(section(README, "## Team").includes(`Saúl (${X}) and c0der.`), `README's team links ${X}`);
  assert.ok(section(KIT_README, "## Team").includes(`Saúl (${X}) and c0der.`), `the kit's README draft links ${X}`);
  // SUBMISSION's team step, whole: nothing to paste, its note, the lead by the handle and c0der by its name, and no
  // address anywhere in it: no full name, no prize wallet
  const NOTE = "The lead's full name and the prize wallet are typed in the form by Saúl, never written here: this file is public.";
  const team = norm(TEAM);
  assert.ok(team.startsWith("### your team Nothing to paste: "), "SUBMISSION's team step: nothing to paste");
  assert.ok(team.includes(NOTE), `SUBMISSION's team step says: ${NOTE}`);
  assert.ok(team.includes("The team is Saúl (@0xultravioleta), the lead, and c0der, added as a member only if Saúl decides (up to 4 people, each on one team only)."), "SUBMISSION's team step: the lead and c0der");
  assert.doesNotMatch(TEAM, /0x[0-9a-fA-F]{40}|```|@[\w.-]+\.\w/, "SUBMISSION's team step: an address, a block or an email");
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
  // the wallet's placeholder is the payout wallet's row of the kit's table (the docs/kit test above)
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
