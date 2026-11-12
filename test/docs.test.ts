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
// and no full name or prize wallet in this public repo (the owner types them in the form). The edit of 12 Nov 2026 adds
// what was read on chain and from Execution Market that day (docs/evidence/robinhood-2026-11-12.json): every USDG and
// $WIF transfer of the merchant (so tx_hashes is every $WIF transfer it made, and each README row of the later paid
// calls says that transaction's own amounts), the ERC-8004 identities on Robinhood Chain, the KarmaKadabra swarm's two
// tasks there, and the ratings none of them has yet; and the plan of the edit, one row per field. No network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

/** one token transfer, as a receipt's Transfer log gives it; the amount in the token's units, as the docs write it */
interface Moved {
  token: "USDG" | "$WIF";
  from: string;
  to: string;
  amount: string;
}
interface Receipt {
  tx: string;
  status: number;
  at: string;
  transfers: Moved[];
  /** who signed each EIP-3009 authorization USDG executed in it (its AuthorizationUsed events) */
  usdg_eip3009_authorizers: string[];
}
/** what was read on Robinhood Chain, on Base, from Execution Market and from the swarm's graph on 12 Nov 2026 */
interface Evidence {
  read_at: string;
  merchant: string;
  facilitator: string;
  merchant_transfers: {
    from_block: number;
    to_block: number;
    items: (Moved & { tx: string; at: string; sender: string })[];
    /** transfers into the merchant that no settlement made (its own funding): counted, their senders not kept */
    left_out: { count: number; tokens: string[]; why: string };
    /** how many transactions the merchant has sent, up to the block read */
    merchant_nonce: number;
  };
  erc8004: {
    identity_registry: string;
    parties: {
      role: string;
      wallet: string;
      robinhood: { agent_id: number; owner: string; ratings_clients: number; transfers: { from: string; to: string; tx: string; at: string }[] };
      base?: { agent_id: number; owner: string; ratings_clients: number };
    }[];
  };
  execution_market: {
    reputation_networks_robinhood: { network: string; chain_id: number; selectable_for_reputation: boolean; rater_authored_ratings: boolean };
    merchant_registrations: Record<"robinhood" | "base", { agent_id: number; status: string }>;
    tasks: {
      id: string;
      status: string;
      payment_network: string;
      payment_token: string;
      agent_id: string;
      erc8004_agent_id: string;
      executor_id: string;
      escrow_status: string;
      escrow_tx: Receipt | null;
      payment_tx: Receipt | null;
    }[];
  };
  karmakadabra_graph: { tasks: { task: string; buyer_wallet: string; worker: string; worker_wallet: string; worker_executor_id: string }[] };
}
const EVIDENCE_FILE = "docs/evidence/robinhood-2026-11-12.json";
const EV: Evidence = JSON.parse(readFileSync(EVIDENCE_FILE, "utf8"));
const lc = (a: string) => a.toLowerCase();
/** the $WIF transfers the merchant sent, oldest first: every one it has made on mainnet up to the block read */
const WIF_SENT = EV.merchant_transfers.items.filter((i) => i.token === "$WIF" && lc(i.from) === lc(EV.merchant));
const SWARM_TASKS = EV.execution_market.tasks.filter((t) => EV.karmakadabra_graph.tasks.some((g) => g.task === t.id));
/** every transaction the reads name, with the transfers it made */
const READ_TXS = new Map<string, Moved[]>([
  ...EV.merchant_transfers.items.map((i) => [i.tx, [i]] as [string, Moved[]]),
  ...EV.execution_market.tasks.flatMap((t) => [t.escrow_tx, t.payment_tx].filter((r): r is Receipt => r !== null).map((r) => [r.tx, r.transfers] as [string, Moved[]])),
]);
const IDENTITY_TXS = new Set(EV.erc8004.parties.flatMap((p) => p.robinhood.transfers.map((t) => t.tx)));
const MERCHANT_RH = EV.erc8004.parties.find((p) => lc(p.wallet) === lc(EV.merchant))!.robinhood;
/** the marker SUBMISSION gives demo_video_url until the new video is uploaded (c0der puts the link in) */
const VIDEO_PENDING = "<<VIDEO_V2>>";
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

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
    // the form shows text as typed: no markdown, links as bare URLs (the video's marker is no text to paste: below)
    if (f.key === "demo_video_url" && text === VIDEO_PENDING) continue;
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
  // only the ones that move $WIF (the field asks for transactions "where your product uses $wif", and the judges' panel
  // marks each one "moves $wif" or "no $wif moved"): every $WIF transfer the merchant has made on mainnet, as read on
  // chain on 12 Nov 2026, oldest first. No Base transaction (the identity's), no USDG payment, no escrow, and none of
  // the swarm's tasks (Flat Fee is no party to them, and they move no $WIF)
  assert.deepEqual(lines, WIF_SENT.map((i) => i.tx), "tx_hashes: every $WIF transfer the merchant made, in order");
  // the 2 Nov cashback and the 7 Nov hire's cashback and reward (the run's own output) are among them, with the same
  // amounts the run gives
  assert.deepEqual(lines.slice(0, 3), [EARLIER_TXS.cashback, RUN.txs.cashback, RUN.txs.reward], "tx_hashes: the run's first");
  for (const [h, want] of [[RUN.txs.cashback, RUN.deltas.payerWif], [RUN.txs.reward, RUN.deltas.workerWif]] as const) {
    assert.equal(WIF_SENT.find((i) => i.tx === h)?.amount, wif(want), `${h}: the chain read and the run agree`);
  }
  // and the chain reads are the deploy's merchant, over the blocks from before the 2 Nov question on
  assert.equal(lc(EV.merchant), lc(CFG.payTo), "the reads are of the deploy's merchant");
  assert.ok(EV.merchant_transfers.from_block <= 103875528 && EV.merchant_transfers.to_block > 112_000_000, "the blocks read");
  // each one is a Robinhood Chain transaction the README links to, on a row that moves "<n> $WIF"; and every README
  // row that moves $WIF is here
  const rows = README.split("\n").filter((l) => l.startsWith("| ") && /robinhoodchain\.blockscout\.com\/tx\//.test(l));
  const movesWif = new Set(rows.filter((l) => /(?<![\w.])\d+ \$WIF\b/.test(l.split("](")[0])).flatMap((l) => [...l.matchAll(TX)].map((m) => m[1])));
  assert.deepEqual([...movesWif].sort(), [...lines].sort(), "tx_hashes: exactly the README's rows that move $WIF");
  // and the note under the block, the intro and the click list say how many there are, and why
  const note = norm(section(FORM_SECTION, "### transactions · `tx_hashes` · a list, one hash per line"));
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  assert.ok(note.includes(`The ${words[lines.length]} that move $WIF, on Robinhood Chain mainnet, as the README cites them`), `the note under tx_hashes: ${note}`);
  assert.ok(note.includes("They are every $WIF transfer the merchant has made on mainnet"), `the note under tx_hashes says they are all: ${note}`);
  for (const [name, doc] of [["SUBMISSION.md", SUBMISSION], ["docs/kit/00-CLICKS.md", KIT_CLICKS]]) {
    const counts = [...norm(doc).matchAll(/\bthe (\w+) (?:hashes|Robinhood Chain transactions)\b/gi)].map((m) => m[1].toLowerCase());
    assert.ok(counts.length > 0, `${name} says how many hashes`);
    for (const c of counts) assert.equal(c, words[lines.length], `${name}: "the ${c} hashes", and there are ${lines.length}`);
  }
});

test("SUBMISSION's answers: the links are the README's, every amount is the deploy's or the run's", () => {
  const top = /^Built for .*Demo video: (\S+) · Live demo: (\S+) ·$/m.exec(README);
  assert.ok(top, "README's links line");
  // the video: the README's, or the marker while the new one is not uploaded; then the note under it says not to paste
  // the marker and to leave the form with the README's video (the one published)
  if (answer("demo_video_url") === VIDEO_PENDING) {
    const note = norm(section(FORM_SECTION, `### demo video · \`demo_video_url\` · ${VIDEO_PENDING.length} of 300 chars`));
    assert.ok(note.includes(`Until then, do not paste the marker: leave the field with the video of 2 Nov, ${top[1]}.`), `the note under the video's marker: ${note}`);
    assert.match(norm(KIT_CLICKS), new RegExp(`paste the new video's link only once it replaces ${esc(VIDEO_PENDING)} in SUBMISSION\\.md; until then leave the field as it is`), "the click list: the marker is not pasted");
  } else {
    assert.equal(answer("demo_video_url"), top[1]);
  }
  assert.equal(answer("live_url"), top[2]);
  const repo = /`git clone (\S+) && cd/.exec(README);
  assert.ok(repo, "README's clone line");
  assert.equal(answer("repo_url"), repo[1]);
  for (const k of ["repo_url", "demo_video_url", "live_url"]) {
    if (answer(k) !== VIDEO_PENDING) assert.match(answer(k), /^https:\/\/\S+$/, k);
  }
  // each `<n> USDG` and `<n> $WIF` of the answers: a price, the bounty, the worker's pay in the run, the cashback, the
  // reward, the holder minimum or the day's budget
  const n = (atomic: bigint, decimals: number) => Number(formatUnits(atomic, decimals));
  const allowed = new Set([
    ...[CFG.prices.ask, CFG.prices.askHolder, CFG.prices.hire, CFG.prices.hireHolder, EM.bounty, BigInt(RUN.deltas.workerUsdg)].map((a) => `${n(a, 6)} USDG`),
    ...[CFG.wif.cashback, CFG.wif.workerReward, CFG.wif.holderMin, CFG.wif.dailyBudget].map((a) => `${n(a, 18)} $WIF`),
  ]);
  // how it's made also gives the swarm's amounts (what each buyer locked and what the escrow paid the agent that
  // delivered), as read on chain; no other answer gives them
  const swarm = new Set(
    SWARM_TASKS.flatMap((t) => {
      const worker = EV.karmakadabra_graph.tasks.find((g) => g.task === t.id)!.worker_wallet;
      return [
        ...t.escrow_tx!.transfers.filter((x) => lc(x.from) === lc(t.agent_id)),
        ...t.payment_tx!.transfers.filter((x) => lc(x.to) === lc(worker)),
      ].map((x) => `${Number(x.amount)} ${x.token}`);
    }),
  );
  for (const a of ANSWERS) {
    for (const b of a.blocks) {
      for (const x of amounts(b).filter((s) => /(USDG|\$WIF)$/.test(s))) {
        assert.ok(allowed.has(x) || (a.key === "how_its_made" && swarm.has(x)), `${a.key}: "${x}" is not the deploy's, the run's or the swarm's`);
      }
    }
  }
  // and it says each of them, with what it was: every swarm task locked the same and paid its worker the same, net of
  // Execution Market's fee
  assert.equal(swarm.size, 2, `the swarm's tasks locked one amount and paid one amount: ${[...swarm]}`);
  const [lock, pay] = [...swarm].sort((x, y) => parseFloat(y) - parseFloat(x));
  const pct = Math.round((1 - parseFloat(pay) / parseFloat(lock)) * 100);
  assert.ok(
    norm(HOW_ITS_MADE).includes(
      `Our KarmaKadabra agents hire each other on Execution Market too: in ${NUMBER_WORDS[SWARM_TASKS.length]} tasks each buyer locked ${lock} in escrow on Robinhood Chain and the agent that delivered got ${pay}, net of a ${pct}% fee.`,
    ),
    `how_its_made: the swarm's tasks, ${lock} locked and ${pay} paid`,
  );
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
  // and what refills that cap on the live demo (README's Safety: every restart starts with an empty DATA_DIR)
  assert.ok(norm(HOW_ITS_MADE).includes(`(WIF_DAILY_BUDGET, src/wif.ts), reset by a restart of the demo's container.`), "how_its_made: what resets the cap");
  assert.ok(norm(SAFETY).includes("on Lightsail, every restart or redeploy of the container starts with an empty disk"), "README's Safety: the restart");
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

test("every transaction both docs link to is the run's, the 2 Nov question's, the identity's or one read on chain on 12 Nov, hash for hash", () => {
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    const links = [...doc.matchAll(TX)].map((m) => m[1]);
    // SUBMISSION gives the form hashes (above), and need link none
    assert.ok(links.length > 0 || doc === SUBMISSION);
    for (const h of links) {
      assert.ok(KEY_OF.has(h) || EARLIER.has(h) || READ_TXS.has(h) || IDENTITY_TXS.has(h), `${name} links to ${h}, a transaction of no run or read on record`);
    }
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
  // the task ids either doc names: the run's, and the other Execution Market tasks read on 12 Nov 2026 (the 8 Nov hire
  // and the swarm's two), no other
  const known = new Set([RUN.emTaskId, ...EV.execution_market.tasks.map((t) => t.id)]);
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
    const ids = [...doc.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0]);
    assert.ok(ids.includes(RUN.emTaskId), `${name} names the task ${RUN.emTaskId}`);
    for (const id of ids) assert.ok(known.has(id), `${name} names the task ${id}, which no run or read gives`);
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
  assert.equal(rows.find((r) => r[3] === "payout_address")![6], "the prize wallet, typed by the owner in the form", "the kit's payout wallet row");
  // the anchor both use is the heading's
  const link = `../../SUBMISSION.md#${anchor(FORM_HEADING)}`;
  assert.equal(anchor(FORM_HEADING), "form-fields-worldisflatfun-edit-submission");
  for (const [name, doc] of [["form-fields.md", KIT_FORM], ["00-CLICKS.md", KIT_CLICKS]]) {
    assert.ok(doc.includes(`](${link})`), `${name} links to ${link}`);
    // no placeholder left at all: the owner types the lead's own fields in the form, from no file here
    assert.deepEqual(doc.match(/\[[A-Z][A-Z0-9_]*\]/g), null, `${name}: a placeholder`);
  }
  assert.ok(SUBMISSION.includes(`](#${anchor(FORM_HEADING)})`), "SUBMISSION's header links to its form section");
  // what the owner pastes or reads to paste names no RPC: not the public one, not the variable (c0der, 2026-11-08)
  for (const [name, doc] of [["SUBMISSION.md", SUBMISSION], ...[...KIT].map(([f, d]) => [`docs/kit/${f}`, d])]) {
    assert.doesNotMatch(doc, /rpc/i, `${name} names an RPC`);
  }
  // form-fields.md maps the form and holds nothing to paste: no text block at all
  assert.equal([...KIT_FORM.matchAll(/^```/gm)].length, 0, "form-fields.md: a block to paste");
  // the form opens with the answers of 2 Nov and maxlength cuts without a word: every paste goes over a selected field
  for (const [name, doc] of [["SUBMISSION, the form section's intro", FORM_INTRO], ["docs/kit/form-fields.md", KIT_FORM], ["docs/kit/00-CLICKS.md", KIT_CLICKS]]) {
    const plain = norm(doc).replace(/\*/g, "");
    assert.match(plain, /in every field,? select all \(Cmd\+A\) and paste the block (?:of SUBMISSION\.md's Form fields )?over it/, `${name}: select all, then paste over it`);
    assert.match(plain, /\btransactions(?:,|:) delete every item that is there first/, `${name}: empty transactions first`);
  }
  // every other file of the kit opens with the notice that it is outdated
  for (const [f, doc] of KIT) {
    if (f === "form-fields.md" || f === "00-CLICKS.md") continue;
    assert.match(doc, /^> \*\*Outdated\.\*\* /, `docs/kit/${f} says it is outdated`);
  }
});

test("the team: the owner's X and c0der in both docs and the kit; no person's placeholder; the form has no full-name field, and the prize wallet goes only in payout_address", () => {
  const X = "[@0xultravioleta](https://x.com/0xultravioleta)";
  assert.ok(section(README, "## Team").includes(`Saúl (${X}) and c0der.`), `README's team links ${X}`);
  assert.ok(section(KIT_README, "## Team").includes(`Saúl (${X}) and c0der.`), `the kit's README draft links ${X}`);
  // the form's team step (form.js: team_name, email, github_profile, contact_handle, payout_address) has no full-name
  // field: SUBMISSION's team step, form-fields.md and the click list say so in the same words, and none of them asks
  // for a full name
  const TEAM_STEP = "The team step has no full-name field; the prize wallet goes only in payout_address, typed by the owner in the form.";
  assert.deepEqual(FORM.filter((f) => f.step === "your team").map((f) => f.key), ["team_name", "email", "github_profile", "contact_handle", "payout_address"]);
  const team = norm(TEAM);
  assert.ok(team.startsWith("### your team Nothing to paste: "), "SUBMISSION's team step: nothing to paste");
  assert.ok(team.includes("The team is Saúl (@0xultravioleta), the lead, and c0der, added as a member only if Saúl decides (up to 4 people, each on one team only)."), "SUBMISSION's team step: the lead and c0der");
  assert.doesNotMatch(TEAM, /0x[0-9a-fA-F]{40}|```|@[\w.-]+\.\w/, "SUBMISSION's team step: an address, a block or an email");
  for (const [name, doc] of [["SUBMISSION, the team step", TEAM], ["docs/kit/form-fields.md", KIT_FORM], ["docs/kit/00-CLICKS.md", KIT_CLICKS]]) {
    assert.ok(norm(doc).includes(TEAM_STEP), `${name} says: ${TEAM_STEP}`);
  }
  for (const [name, doc] of [["SUBMISSION.md", SUBMISSION], ...[...KIT].map(([f, d]) => [`docs/kit/${f}`, d])]) {
    assert.doesNotMatch(norm(doc), /full name/i, `${name} speaks of a full name the form has no field for`);
  }
  // a person's placeholder (Saúl's, with the accent or without it, or c0der's, with a zero or an O): none anywhere
  const PERSON = /\[(?:SA[UÚ]L|C[0O]DER)_\w*\]/gi;
  assert.ok(KIT.size >= 6 && KIT.has("form-fields.md") && KIT.has("00-CLICKS.md"), "the kit's files");
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION], ...[...KIT].map(([f, d]) => [`docs/kit/${f}`, d])]) {
    assert.deepEqual(doc.match(PERSON), null, `${name}: a [SAUL_…] or [C0DER_…] placeholder`);
  }
  // the click list's section on what only the owner types: that sentence, then nothing else to fill in
  const own = norm(section(KIT_CLICKS, "## What only the owner types"));
  assert.ok(own.includes(TEAM_STEP), `the click list says: ${TEAM_STEP}`);
  assert.doesNotMatch(own.replace(TEAM_STEP, ""), /name|wallet|e-?mail|handle|personal|address|\[/i, `the click list asks for nothing else: ${own}`);
});

test("README links no private UltravioletaDAO repository, and the demo's example task asks for a text answer", () => {
  // Execution Market's repository is private (a judge sees 404): the README points at https://execution.market
  assert.doesNotMatch(README, /github\.com\/UltravioletaDAO\/execution-market/i, "README links the private execution-market repo");
  assert.ok(section(README, "## What existed before, and what was built during the hackathon").includes("[Execution Market](https://execution.market)"));
  // Execution Market takes only text_response: the task the live page offers, and npm run demo's, ask for text
  const page = readFileSync("public/index.html", "utf8");
  const task = /<textarea id="request"[^>]*>([^<]*)<\/textarea>/.exec(page)?.[1];
  assert.ok(task, "public/index.html has the #request textarea");
  const demo = /request: "([^"]+)"/.exec(readFileSync("scripts/demo-fork.ts", "utf8"))?.[1];
  for (const [name, t] of [["public/index.html #request", task], ["scripts/demo-fork.ts", demo]] as const) {
    assert.ok(t, name);
    assert.doesNotMatch(t, /photo|picture|image|video|selfie|upload/i, `${name} asks for more than text: ${t}`);
    assert.match(t, /\bin text\b/, `${name} asks for a text answer: ${t}`);
  }
});

const PLAN_HEADING = "## What changes and where (edit of 12 Nov 2026)";
const EVIDENCE_HEADING = "## What the new texts stand on (read 12 Nov 2026)";
const LATER_HEADING = "### Two more paid calls from the team (7 and 8 Nov 2026)";
const SWARM_HEADING = "### The same market, used by our agent swarm (11-12 Nov 2026)";

/**
 * What a README row must say next to a transaction read on chain: its amounts and who paid whom. A payment out of an
 * escrow gives the worker's part, Execution Market's part and that part as a share; any other transfer, its amount and
 * its direction.
 */
function expectedFor(h: string): { words: string[]; amounts: string[] } {
  const paid = EV.execution_market.tasks.find((t) => t.payment_tx?.tx === h);
  if (paid) {
    const parts = [...paid.payment_tx!.transfers].sort((a, b) => Number(a.amount) - Number(b.amount));
    assert.equal(parts.length, 2, `${h}: a fee and the worker's pay`);
    const [fee, pay] = parts;
    const pct = Math.round((Number(fee.amount) / (Number(fee.amount) + Number(pay.amount))) * 100);
    // the worker by name: the swarm's from its graph, Flat Fee's test worker as "the worker"
    const g = EV.karmakadabra_graph.tasks.find((x) => x.task === paid.id);
    if (g) assert.equal(lc(pay.to), lc(g.worker_wallet), `${h}: paid the swarm's worker`);
    else assert.equal(lc(pay.to), lc(WORKER), `${h}: paid the test worker`);
    return {
      words: [`${pay.amount} USDG to ${g ? g.worker : "the worker"}`, `${fee.amount} USDG to Execution Market`, `${pct}% fee`],
      amounts: [`${Number(pay.amount)} USDG`, `${Number(fee.amount)} USDG`, `${pct} %`],
    };
  }
  const locked = EV.execution_market.tasks.find((t) => t.escrow_tx?.tx === h);
  if (locked) {
    const first = locked.escrow_tx!.transfers[0];
    const payer = lc(first.from) === lc(EV.merchant) ? "merchant" : "buyer";
    assert.equal(lc(first.from), lc(locked.agent_id), `${h}: the publisher locks the bounty`);
    return { words: [`${first.amount} USDG`, `${payer} → Execution Market's escrow`], amounts: [`${Number(first.amount)} USDG`] };
  }
  const i = EV.merchant_transfers.items.find((x) => x.tx === h);
  assert.ok(i, `${h} was not read on chain`);
  const who = (a: string) => (lc(a) === lc(EV.merchant) ? "merchant" : lc(a) === lc(BUYER) ? "buyer" : lc(a) === lc(WORKER) ? "worker" : a);
  return { words: [`${i.amount} ${i.token}`, `${who(i.from)} → ${who(i.to)}`], amounts: [`${Number(i.amount)} ${i.token}`] };
}
/** the amounts of a text that carry a token or a percent sign (times and dates carry none) */
const tokenAmounts = (text: string) => amounts(text).filter((a) => / (?:USDG|\$WIF|%)$/.test(a));

test("README: each row of the later paid calls and of the swarm's tasks is a transaction read on chain, with its own amounts and direction", () => {
  const cited = new Set<string>();
  for (const heading of [LATER_HEADING, SWARM_HEADING]) {
    const rows = section(README, heading).split("\n").filter((l) => l.startsWith("| ") && /blockscout\.com\/tx\//.test(l));
    assert.ok(rows.length > 0, `README, ${heading}: rows`);
    for (const row of rows) {
      const links = [...row.matchAll(TX)];
      assert.equal(links.length, 1, `one transaction per row: ${row}`);
      const h = links[0][1];
      const before = row.slice(0, links[0].index);
      const want = expectedFor(h);
      for (const w of want.words) assert.ok(norm(before).includes(w), `README, ${heading}: next to ${h} it should say "${w}": ${before}`);
      for (const a of tokenAmounts(before)) assert.ok(want.amounts.includes(a), `README, ${heading}: "${a}" next to ${h} is not what it moved: ${before}`);
      assert.deepEqual(tokenAmounts(row.slice(links[0].index! + links[0][0].length)), [], `an amount after the transaction: ${row}`);
      // the label of the link is its own hash
      const label = /\[(0x[0-9a-f]{4})…([0-9a-f]{4})\]\($/.exec(before);
      assert.ok(label && label[1] + label[2] === h.slice(0, 6) + h.slice(-4), `the label of ${h}: ${before}`);
      cited.add(h);
    }
  }
  // every transfer of the merchant after the 7 Nov run, and every escrow lock and payment of the 8 Nov hire and of the
  // swarm's tasks, has its row
  const runEnd = RUN.seen.at(-1)!.at;
  const want = [
    ...EV.merchant_transfers.items.filter((i) => i.at > runEnd).map((i) => i.tx),
    ...EV.execution_market.tasks.filter((t) => t.id !== RUN.emTaskId).flatMap((t) => [t.escrow_tx!.tx, t.payment_tx!.tx]),
  ];
  assert.deepEqual([...cited].sort(), [...new Set(want)].sort(), "README: every later transaction read on chain, and no other");
  // every $WIF transfer went to a team wallet (the buyer of every paid call, and the hires' test worker); the README and
  // how does it use $wif say so, and the 8 Nov hire's worker is said to be the same test wallet
  for (const i of WIF_SENT) assert.ok([lc(BUYER), lc(WORKER)].includes(lc(i.to)), `${i.tx} went to ${i.to}, no team wallet`);
  const later = norm(section(README, LATER_HEADING));
  assert.ok(later.includes(`${NUMBER_WORDS[WIF_SENT.length]} $WIF transfers, all of them to wallets of the team`), later);
  assert.ok(norm(answer("wif_usage")).includes("are all in transactions; every one went to a wallet of the team."), "wif_usage: whose wallets");
  assert.ok(later.toLowerCase().includes(TEAM_BUYER), `README, ${LATER_HEADING}: the buyer is ${TEAM_BUYER}`);
  assert.ok(later.includes("The second hire's worker is the same team test wallet as the first's") && later.includes("a script, not a person"), later);
  const t8 = EV.execution_market.tasks.find((t) => t.id !== RUN.emTaskId && lc(t.agent_id) === lc(EV.merchant))!;
  assert.ok(t8.status === "completed" && t8.escrow_status === "released", "the 8 Nov hire: completed, released");
  assert.ok(t8.payment_tx!.transfers.some((x) => lc(x.to) === lc(WORKER)), "the 8 Nov hire paid the same test worker");
});

test("ERC-8004 on Robinhood Chain: the merchant's identity as read on chain and as Execution Market records it, in how it's made and the README", () => {
  assert.equal(lc(MERCHANT_RH.owner), lc(EV.merchant), "the merchant owns its Robinhood Chain identity");
  assert.equal(EV.execution_market.merchant_registrations.robinhood.agent_id, MERCHANT_RH.agent_id, "Execution Market records the same");
  const base = EV.erc8004.parties.find((p) => lc(p.wallet) === lc(EV.merchant))!.base!;
  assert.ok(base.agent_id === Number(IDENTITY.agent) && lc(base.owner) === lc(EV.merchant), "and the Base one is the README's");
  assert.equal(EV.execution_market.merchant_registrations.base.agent_id, Number(IDENTITY.agent));
  // the facilitator minted it to itself, then transferred it to the merchant, as with the Base one
  const [mint, transfer] = MERCHANT_RH.transfers;
  assert.ok(mint.from === `0x${"0".repeat(40)}` && lc(mint.to) === lc(EV.facilitator), "the mint, to the facilitator");
  assert.ok(lc(transfer.from) === lc(EV.facilitator) && lc(transfer.to) === lc(EV.merchant), "the transfer, to the merchant");
  assert.ok(mint.at.startsWith("2026-11-07T18:47") && transfer.at.startsWith("2026-11-07T18:47"), "on 7 Nov 2026 at 18:47 UTC");
  assert.ok(norm(HOW_ITS_MADE).includes(`ERC-8004 agent ${MERCHANT_RH.agent_id} on Robinhood Chain`), "how_its_made names it");
  const at = (h: string) => EM_SECTION.indexOf(`https://robinhoodchain.blockscout.com/tx/${h}`);
  assert.ok(at(mint.tx) > 0 && at(mint.tx) < at(transfer.tx), "README: the mint, then the transfer");
  assert.ok(norm(EM_SECTION).includes(`On Robinhood Chain the merchant is agent ${MERCHANT_RH.agent_id}`), "README names it");
  assert.ok(norm(EM_SECTION).includes(`?network=robinhood`), "README links Execution Market's record of it");
  // the 8 Nov hire's task names its publisher by that identity
  const t8 = EV.execution_market.tasks.find((t) => t.id !== RUN.emTaskId && lc(t.agent_id) === lc(EV.merchant))!;
  assert.equal(t8.erc8004_agent_id, String(MERCHANT_RH.agent_id));
  assert.ok(norm(section(README, LATER_HEADING)).includes(`names its publisher as agent ${MERCHANT_RH.agent_id}`));
  // every identity number the README and SUBMISSION give on Robinhood Chain is one read there, owned by its wallet
  for (const p of EV.erc8004.parties) {
    assert.equal(lc(p.robinhood.owner), lc(p.wallet), `${p.role}: owns ${p.robinhood.agent_id}`);
    assert.ok(p.robinhood.transfers.some((t) => lc(t.from) === lc(EV.facilitator) && lc(t.to) === lc(p.wallet)), `${p.role}: from the facilitator`);
    for (const [name, text] of [["README, the swarm", section(README, SWARM_HEADING)], ["SUBMISSION, what the texts stand on", section(SUBMISSION, EVIDENCE_HEADING)]]) {
      assert.match(text, new RegExp(`\\b${p.robinhood.agent_id}\\b`), `${name} names ${p.robinhood.agent_id} (${p.role})`);
    }
  }
});

test("the swarm's tasks: on Robinhood Chain in USDG, between agents of the swarm, completed and paid out of escrow, as what it does says", () => {
  assert.equal(SWARM_TASKS.length, 2, "two tasks");
  for (const t of SWARM_TASKS) {
    const g = EV.karmakadabra_graph.tasks.find((x) => x.task === t.id)!;
    assert.deepEqual([t.payment_network, t.payment_token, t.status, t.escrow_status], ["robinhood", "USDG", "completed", "released"], t.id);
    // the buyer published it, the swarm's graph has the buyer's wallet and the worker that took it
    assert.equal(lc(g.buyer_wallet), lc(t.agent_id));
    assert.equal(g.worker_executor_id, t.executor_id);
    const lock = t.escrow_tx!;
    const pay = t.payment_tx!;
    assert.ok(lock.status === 1 && pay.status === 1, `${t.id}: both mined`);
    assert.ok(lock.transfers.some((x) => x.token === "USDG" && lc(x.from) === lc(t.agent_id)), `${t.id}: the buyer locked USDG`);
    assert.ok(pay.transfers.some((x) => x.token === "USDG" && lc(x.to) === lc(g.worker_wallet)), `${t.id}: the escrow paid the worker`);
    assert.ok(lock.at.startsWith("2026-11-11") && pay.at.startsWith("2026-11-12"), `${t.id}: locked on 11 Nov, paid on 12 Nov 2026`);
    // Flat Fee is no party to them: its merchant moves nothing in either
    for (const x of [...lock.transfers, ...pay.transfers]) assert.ok(lc(x.from) !== lc(EV.merchant) && lc(x.to) !== lc(EV.merchant), `${t.id}: the merchant`);
    // both the buyer and the worker hold an ERC-8004 identity on Robinhood Chain
    for (const w of [t.agent_id, g.worker_wallet]) {
      const p = EV.erc8004.parties.find((x) => lc(x.wallet) === lc(w));
      assert.ok(p && lc(p.robinhood.owner) === lc(w), `${t.id}: ${w} holds an identity on Robinhood Chain`);
    }
    for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]]) {
      assert.ok(doc.includes(`https://execution.market/tasks/${t.id}`), `${name} links Execution Market's page of ${t.id}`);
    }
  }
  assert.ok(
    norm(WHAT_IT_DOES).includes("two agents of KarmaKadabra, our swarm of AI agents, hired two others there, and both tasks were paid out of USDG escrow on Robinhood Chain"),
    "what_it_does: the swarm's tasks",
  );
  for (const [name, text] of [["README", section(README, SWARM_HEADING)], ["SUBMISSION", section(SUBMISSION, EVIDENCE_HEADING)]]) {
    assert.ok(norm(text).includes("Flat Fee is not a party to these tasks"), `${name} says Flat Fee is not a party to them`);
  }
});

test("ratings: none yet, on Robinhood Chain nor for Flat Fee on Base, and Execution Market writes none there; what's next and both docs say so", () => {
  const rh = EV.execution_market.reputation_networks_robinhood;
  assert.ok(rh.network === "robinhood" && rh.chain_id === 4663 && rh.selectable_for_reputation === false, "Execution Market: robinhood not selectable for ratings");
  // when a rating appears in a later read, these fail, and the texts below change with it
  for (const p of EV.erc8004.parties) assert.equal(p.robinhood.ratings_clients, 0, `${p.role}: raters on Robinhood Chain`);
  const merchant = EV.erc8004.parties.find((p) => lc(p.wallet) === lc(EV.merchant))!;
  assert.equal(merchant.base!.ratings_clients, 0, "Flat Fee's merchant: raters on Base");
  // the swarm's agents carry ratings on Base from earlier tasks: the README gives each identity there and its raters
  const SWARM = norm(section(README, SWARM_HEADING));
  const swarmParties = EV.erc8004.parties.filter((p) => p.base && lc(p.wallet) !== lc(EV.merchant));
  assert.equal(swarmParties.length, 4, "the swarm's four agents, with their Base identities");
  for (const p of swarmParties) {
    assert.equal(lc(p.base!.owner), lc(p.wallet), `${p.role}: owns ${p.base!.agent_id} on Base`);
    assert.ok(p.base!.ratings_clients > 0, `${p.role}: raters on Base`);
  }
  const [b1, b2] = swarmParties.filter((p) => p.role.startsWith("swarm buyer")).map((p) => p.base!);
  const worker = (name: string) => swarmParties.find((p) => p.role.includes(`(${name})`))!.base!;
  const said =
    `the two buyers have ${b1.ratings_clients} and ${b2.ratings_clients} raters (agents ${b1.agent_id} and ${b2.agent_id}), ` +
    `kk-coordinator ${worker("kk-coordinator").ratings_clients} (${worker("kk-coordinator").agent_id}) and kk-trader ${worker("kk-trader").ratings_clients} (${worker("kk-trader").agent_id})`;
  assert.ok(SWARM.includes(said), `README, the swarm: ${said}`);
  assert.ok(norm(answer("whats_next")).includes("Execution Market writes no ratings on Robinhood Chain yet"), "whats_next");
  assert.ok(norm(EM_SECTION).includes("neither of Flat Fee's identities has a rating yet"), "README's Ratings");
  assert.ok(norm(EM_SECTION).includes("Flat Fee itself does not rate its workers yet"), "README's Ratings: Flat Fee rates nobody");
  assert.ok(norm(section(SUBMISSION, EVIDENCE_HEADING)).includes("Ratings on Robinhood Chain: none yet."), "SUBMISSION, what the texts stand on");
  // and the code rates nobody: no rating call to Execution Market anywhere in src/
  for (const f of readdirSync("src").filter((x) => x.endsWith(".ts"))) {
    assert.doesNotMatch(readFileSync(`src/${f}`, "utf8"), /\/rate\b|\/ratings?\b|\/feedback\b/, `src/${f} calls a rating endpoint`);
  }
});

test("SUBMISSION's plan of the edit: one row per field of the form after the team's, what is published, what replaces it and why", () => {
  const plan = section(SUBMISSION, PLAN_HEADING);
  const rows = plan.split("\n").filter((l) => /^\| [^-]/.test(l) && !l.startsWith("| field |"));
  assert.deepEqual(rows.map((r) => /^\| [^|]*`(\w+)` \|/.exec(r)?.[1]), PROJECT_FIELDS.map((f) => f.key), "one row per field, in the form's order");
  for (const r of rows) {
    const cells = r.split("|").slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 4, `four cells: ${r}`);
    assert.ok(cells.every((c) => c.length > 0), `no empty cell: ${r}`);
  }
  // the one liner: the one the site shows today, and this edit's block
  const oneLiner = rows.find((r) => r.includes("`one_liner`"))!;
  assert.ok(oneLiner.includes(`"Ask an agent or hire a human for a flat USDG fee on Robinhood Chain, $WIF back"`), oneLiner);
  assert.ok(oneLiner.includes(`"${answer("one_liner")}"`), oneLiner);
  assert.ok(SUBMISSION.includes(`](#${anchor(PLAN_HEADING)})`), "SUBMISSION's header links to the plan");
});

test("the links between README and SUBMISSION land on a heading", () => {
  const anchors = (doc: string) => new Set(doc.split("\n").filter((l) => /^#{1,6} /.test(l)).map(anchor));
  const of: Record<string, Set<string>> = { "README.md": anchors(README), "SUBMISSION.md": anchors(SUBMISSION) };
  for (const [name, doc] of [["README.md", README], ["SUBMISSION.md", SUBMISSION]] as const) {
    for (const m of doc.matchAll(/\]\(((?:README|SUBMISSION)\.md)?#([^)\s]+)\)/g)) {
      const target = m[1] ?? name;
      assert.ok(of[target].has(m[2]), `${name} links to ${target}#${m[2]}, which is no heading there`);
    }
  }
});

test("every: the merchant sent only the six $WIF transfers, and the reads keep only sales and what it sent, as of the day read", () => {
  // its nonce counts every transaction it ever sent: they are the $WIF transfers, each sent by the merchant itself
  assert.equal(EV.merchant_transfers.merchant_nonce, WIF_SENT.length, "the merchant's transactions are its $WIF transfers");
  for (const i of WIF_SENT) assert.equal(lc(i.sender), lc(EV.merchant), `${i.tx}: sent by the merchant`);
  // the other items are settlements the facilitator submitted (a buyer paying, or an escrow lock); the merchant's own
  // funding is counted, without its senders, which no claim needs
  for (const i of EV.merchant_transfers.items) {
    assert.ok(lc(i.from) === lc(EV.merchant) || lc(i.sender) === lc(EV.facilitator), `${i.tx}: neither sent by the merchant nor a settlement`);
  }
  assert.ok(EV.merchant_transfers.left_out.count >= 0 && /not sales/.test(EV.merchant_transfers.left_out.why), "what is left out, and why");
  // the form says when: "up to" the day the chain was read
  const day = new Date(EV.read_at);
  const when = `${day.getUTCDate()} Nov ${day.getUTCFullYear()}`;
  assert.ok(EV.read_at.startsWith("2026-11-"), EV.read_at);
  assert.ok(norm(answer("wif_usage")).includes(`The ${NUMBER_WORDS[WIF_SENT.length]} $WIF transfers the merchant made on mainnet up to ${when}`), `wif_usage: up to ${when}`);
});

test("the swarm in the form: only the measured sentences, each saying the swarm is the team's own", () => {
  // every sentence of an answer that speaks of the swarm is one of these, word for word (a new claim about it, such as
  // its agents buying from Flat Fee today, or more of them, fails here until it is measured and added)
  const APPROVED = new Set([
    "That market is not only Flat Fee's on Robinhood Chain: on 11 and 12 Nov 2026 two agents of KarmaKadabra, our swarm of AI agents, hired two others there, and both tasks were paid out of USDG escrow on Robinhood Chain.",
    `Our KarmaKadabra agents hire each other on Execution Market too: in two tasks each buyer locked 0.01 USDG in escrow on Robinhood Chain and the agent that delivered got 0.0087 USDG, net of a 13% fee.`,
    "Ratings: Flat Fee and the swarm's agents that hired on Robinhood Chain all hold ERC-8004 identities there, but Execution Market writes no ratings on Robinhood Chain yet.",
    "Then KarmaKadabra's agents as Flat Fee buyers, paying USDG per answer and earning $WIF; an LLM behind the agent; and subscriptions priced in $WIF.",
  ]);
  const seen = new Set<string>();
  for (const a of ANSWERS) {
    for (const b of a.blocks) {
      for (const sentence of b.split(/(?<=[.!?]"?) (?=[A-Z])/)) {
        if (!/karmakadabra|swarm/i.test(sentence)) continue;
        assert.ok(APPROVED.has(sentence), `${a.key}: a sentence about the swarm that was not measured: ${sentence}`);
        seen.add(sentence);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...APPROVED].sort(), "each measured sentence is in its answer");
  // the flywheel's "why they come back" answers only that, with $WIF in every sentence (c0der, 2026-11-12: the swarm is
  // in what it does and how it's made, not in a field that scores the loop)
  for (const sentence of answer("flywheel_return").split(/(?<=\.) (?=[A-Z])/)) assert.match(sentence, /\$WIF/, `flywheel_return: ${sentence}`);
  // and whats_next keeps the swarm as buyers in the future: it is no claim of today
  assert.match(answer("whats_next"), /\. Next, [^.]*\. Then KarmaKadabra's agents as Flat Fee buyers/, "whats_next: the swarm as buyers comes after 'Then'");
});

test("no answer and no new README section says, in the past tense, that people did or earned anything: every worker on record is a team test wallet or an agent", () => {
  const PEOPLE_DID = /\b(?:humans?|people|persons?|someone|somebody|a worker|workers|taskers?)\b(?: \S+){0,5}? (?:took|applied|delivered|completed|did|answered|earned|were paid|was paid|got paid|were hired|was hired|got)\b/i;
  for (const a of ANSWERS) for (const b of a.blocks) assert.doesNotMatch(norm(b).replace(EXPIRY, ""), PEOPLE_DID, a.key);
  for (const heading of [LATER_HEADING, SWARM_HEADING]) assert.doesNotMatch(norm(section(README, heading)), PEOPLE_DID, heading);
  // both sides of every task on record hold an identity on Robinhood Chain: the publisher and the worker
  for (const t of EV.execution_market.tasks) {
    const worker = t.payment_tx!.transfers.reduce((a, b) => (Number(a.amount) > Number(b.amount) ? a : b)).to;
    for (const w of [t.agent_id, worker]) {
      assert.ok(EV.erc8004.parties.some((p) => lc(p.wallet) === lc(w) && lc(p.robinhood.owner) === lc(w)), `${t.id}: ${w} holds an identity on Robinhood Chain`);
    }
  }
  assert.ok(norm(section(README, SWARM_HEADING)).includes("Both sides of each of these tasks and of Flat Fee's two hires, the publisher and the worker, hold an ERC-8004 identity"));
  // and each swarm worker's identity is named with its own name
  for (const g of EV.karmakadabra_graph.tasks) {
    const p = EV.erc8004.parties.find((x) => lc(x.wallet) === lc(g.worker_wallet))!;
    assert.ok(norm(section(README, SWARM_HEADING)).includes(`${p.robinhood.agent_id} (${g.worker})`), `README: ${p.robinhood.agent_id} is ${g.worker}`);
  }
});

test("what it does: the $WIF back and the worker's $WIF have the daily cap, and only holders who name their wallet pay half, as the code does it", () => {
  // src/wif.ts refuses a transfer past WIF_DAILY_BUDGET (the call is still served, without its $WIF, and an approved answer
  // earns no reward: the Execution Market reward draws from the same budget, src/index.ts), and src/app.ts quotes the
  // holder price only to a buyer that named its wallet before the 402
  assert.match(readFileSync("src/index.ts", "utf8"), /\bsendWif: budgetedWif\(cfg, chain, store\)/, "the Execution Market reward draws from the day's budget");
  const sentence =
    `Settled calls send ${wif(CFG.wif.cashback)} $WIF back to the payer, and each worker whose answer Flat Fee approves earns ` +
    `${wif(CFG.wif.workerReward)} $WIF on top, out of one budget of ${wif(CFG.wif.dailyBudget)} $WIF a day; $WIF holders who name their wallet pay half.`;
  assert.ok(norm(WHAT_IT_DOES).includes(sentence), `what_it_does says: ${sentence}`);
  assert.doesNotMatch(WHAT_IT_DOES, /\bevery (?:settled|paid) call sends\b/i, "what_it_does: no $WIF without its cap");
  // and no other sentence of it gives the $WIF without the day's budget, or the half without the named wallet
  for (const s of WHAT_IT_DOES.split(/(?<=[.!?]"?) (?=[A-Z])/)) {
    if (/\$WIF back|cashback|\bearns? \d+ \$WIF/i.test(s)) {
      assert.ok(s.includes(`${wif(CFG.wif.dailyBudget)} $WIF a day`), `what_it_does gives $WIF without the day's budget: ${s}`);
    }
    if (/\bpays? half\b/i.test(s)) assert.ok(s.includes("who name their wallet pay half"), `what_it_does gives the half without the named wallet: ${s}`);
  }
});

test("every answer gives the holder half only to a holder who names their wallet, and the README's hire gives the worker's $WIF its daily cap", () => {
  // src/app.ts (tierFor) quotes the holder price only to a buyer that named its wallet before the 402: each sentence of
  // the form that says holders pay half says so (who_its_for, flywheel_action, flywheel_return, flywheel_wif, what_it_does)
  let halves = 0;
  for (const a of ANSWERS) {
    for (const b of a.blocks) {
      for (const s of b.split(/(?<=[.!?]"?) (?=[A-Z])/)) {
        if (!/\bpays? half\b/i.test(s)) continue;
        halves++;
        assert.match(s, /\bnames? (?:their|its) wallet\b/, `${a.key}: the half without the named wallet: ${s}`);
      }
    }
  }
  assert.ok(halves >= 5, `the sentences that give the holder half: ${halves}`);
  // the README's POST /api/hire: the worker's reward comes out of the budget the cashback draws from (src/wif.ts)
  const hire = `the worker earns ${wif(CFG.wif.workerReward)} $WIF on top, out of the same ${wif(CFG.wif.dailyBudget)} $WIF a day as the cashback ([Safety](#safety))`;
  assert.ok(norm(README).includes(hire), `README's POST /api/hire: ${hire}`);
});

test("the figures around the new rows are the reads': times, dates, the nonce, the identities listed, the tasks' state, the 2 Nov quotes", () => {
  const hhmm = (at: string) => `${Number(at.slice(8, 10))} Nov ${at.slice(11, 16)}`;
  // each later row's time is its transaction's
  for (const row of section(README, LATER_HEADING).split("\n").filter((l) => /^\| \d/.test(l))) {
    const h = [...row.matchAll(TX)][0][1];
    const at = EV.merchant_transfers.items.find((i) => i.tx === h)?.at ?? EV.execution_market.tasks.find((t) => t.payment_tx?.tx === h)!.payment_tx!.at;
    assert.ok(row.startsWith(`| ${hhmm(at)} |`), `the time of ${h}: ${row}`);
  }
  // the mint of 22487: day and minute, in both docs
  const mint = MERCHANT_RH.transfers[0].at;
  const minted = `on ${Number(mint.slice(8, 10))} Nov ${mint.slice(0, 4)} at ${mint.slice(11, 16)} UTC`;
  assert.ok(norm(EM_SECTION).includes(minted) && norm(section(SUBMISSION, EVIDENCE_HEADING)).includes(minted), `the mint: ${minted}`);
  // the merchant's nonce, in words
  assert.ok(norm(section(README, LATER_HEADING)).includes(`the merchant has sent ${NUMBER_WORDS[EV.merchant_transfers.merchant_nonce]} transactions in all, its nonce`));
  // the day each group of identities was minted
  const day = (ids: number[]) => [...new Set(EV.erc8004.parties.filter((p) => ids.includes(p.robinhood.agent_id)).map((p) => p.robinhood.transfers[0].at.slice(0, 10)))];
  assert.deepEqual(day([22487, 22488]), ["2026-11-07"]);
  assert.deepEqual(day([23394, 23395, 25419, 25420]), ["2026-11-11"]);
  const swarm = norm(section(README, SWARM_HEADING));
  assert.ok(swarm.includes("22488 (7 Nov 2026)") && swarm.includes("25420 (kk-trader) (11 Nov 2026)"), "README: the days of the identities");
  // SUBMISSION's list of the other identities on Robinhood Chain is exactly the reads'
  const others = EV.erc8004.parties.map((p) => p.robinhood.agent_id).filter((id) => id !== MERCHANT_RH.agent_id).sort((x, y) => x - y);
  assert.ok(norm(section(SUBMISSION, EVIDENCE_HEADING)).includes(`hold identities on Robinhood Chain too (${others.join(", ")}).`), `the list: ${others}`);
  // the swarm's tasks' state, as the README writes it
  const [state] = [...new Set(SWARM_TASKS.map((t) => `${t.status}/${t.escrow_status}`))];
  assert.equal(new Set(SWARM_TASKS.map((t) => `${t.status}/${t.escrow_status}`)).size, 1);
  assert.ok(swarm.includes(`records show both ${state.split("/")[0]}, their escrows ${state.split("/")[1]}`), `README: the swarm's tasks are ${state}`);
  // the swarm's raters on Base, in SUBMISSION too
  const raters = EV.erc8004.parties.filter((p) => p.base && lc(p.wallet) !== lc(EV.merchant)).map((p) => p.base!.ratings_clients);
  assert.ok(norm(section(SUBMISSION, EVIDENCE_HEADING)).includes(`their ERC-8004 identities there have ${raters.slice(0, -1).join(", ")} and ${raters.at(-1)} raters`), `SUBMISSION: ${raters}`);
});

test("the plan's quotes of what is published are the 2 Nov text (45fab02), word for word", (t) => {
  let then: string;
  try {
    then = execFileSync("git", ["show", "45fab02:SUBMISSION.md"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    t.skip("no git history here (a shallow checkout): the 2 Nov text cannot be read");
    return;
  }
  const plan = section(SUBMISSION, PLAN_HEADING);
  const quotes = plan.split("\n").filter((l) => /^\| [^-]/.test(l) && !l.startsWith("| field |")).flatMap((r) => [...r.split("|")[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  assert.ok(quotes.length >= 3, `the plan quotes: ${quotes}`);
  for (const q of quotes) assert.ok(then.includes(q), `"${q}" is not in SUBMISSION.md at 45fab02`);
});
