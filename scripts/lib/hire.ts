// `npm run e2e:hire`, kept apart from the network so it can be tested (test/hire.test.ts): the rules a live hire run
// checks before it reads the chain or signs anything, and the run itself, from a buyer's x402 payment to the worker's
// escrow payout and $WIF, with every transaction and every Execution Market status it saw.
import { computeAddress, getAddress, isAddress } from "ethers";
import { CHAINS, USDG_DECIMALS, WIF_DECIMALS, formatUnits, parseUnitsStrict, privateKey, type Config } from "../../src/config.js";
import { confirms } from "./buyer.js";
import { ledgerCashback, remoteRefusal } from "./live.js";

type Env = Record<string, string | undefined>;

export type WorkerMode = "manual" | "token" | "erc8128";

/** what the run does, read from the environment once the rules passed */
export interface HirePlan {
  /** the running Flat Fee to buy from (the deploy), an origin */
  flatfee: string;
  /** Execution Market's API origin, for the worker */
  emApi: string;
  mode: WorkerMode;
  /** the worker's payout wallet */
  worker: string;
  /** the buyer's task, as Flat Fee publishes it on Execution Market */
  request: string;
  /** the text the worker delivers, and the answer the buyer must get back */
  answer: string;
  /** the amounts the owner approved: what the buyer pays, the merchant's escrow, the worker's and the buyer's $WIF */
  approved: { spend: string; bounty: string; reward: string; cashback: string | null };
  pollMs: number;
  timeoutMs: number;
}

const TX = /^0x[0-9a-fA-F]{64}$/;
const isTx = (v: unknown): v is string => typeof v === "string" && TX.test(v);
const sameAddr = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();

/** an http(s) origin: https, or http for localhost; null when it is not one */
export function origin(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

/**
 * The private RPC is the only one a live run uses: RPC_URL must be set, and must not be a public RPC of Robinhood
 * Chain. The value is never repeated: it carries the provider's key.
 */
export function rpcRefusal(env: Env): string | null {
  const v = env.RPC_URL?.trim();
  if (!v) return "RPC_URL is not set: a live hire run reads balances only through the private RPC";
  let host = "";
  try {
    host = new URL(v).hostname.toLowerCase();
  } catch {
    return "RPC_URL is not a URL; the value is not shown";
  }
  const publics = [CHAINS.robinhood.rpcUrl, CHAINS["robinhood-testnet"].rpcUrl].map((u) => new URL(u).hostname);
  if (publics.includes(host) || host.endsWith(".chain.robinhood.com")) return "RPC_URL is a public RPC of Robinhood Chain: set the private one";
  return null;
}

const MODES: WorkerMode[] = ["manual", "token", "erc8128"];

/**
 * Why a live hire run must stop before it reads the chain or signs anything, or the plan when it may go ahead.
 * `payer` is the buyer's wallet (from PAYER_PRIVATE_KEY). Every amount the run can move is approved up front, in the
 * spirit of e2e:mainnet: CONFIRM_MAINNET_SPEND (what the buyer pays, exactly), CONFIRM_MAINNET_BOUNTY (what the
 * merchant locks in escrow), CONFIRM_MAINNET_REWARD (the worker's $WIF) and, when the server sends a cashback,
 * CONFIRM_MAINNET_WIF (the buyer's $WIF). They are checked against the server's /api/info by remoteHireRefusal.
 */
export function hirePlanRefusal(cfg: Config, env: Env, payer: string): { refusal: string } | { plan: HirePlan } {
  const no = (refusal: string) => ({ refusal });
  // Robinhood Chain testnet has no Execution Market escrow: the run only exists on mainnet
  if (cfg.chain.name !== "robinhood") return no("e2e:hire runs on mainnet only (NETWORK=robinhood): Execution Market has no escrow on the testnet");
  const rpc = rpcRefusal(env);
  if (rpc) return no(rpc);
  const flatfee = origin(env.FLATFEE_URL);
  if (!flatfee) return no("FLATFEE_URL must be the running Flat Fee to buy from, an https origin (e.g. https://flatfee.ultravioletadao.xyz)");
  const emApi = origin(env.EM_API_URL?.trim() || "https://api.execution.market");
  if (!emApi) return no("EM_API_URL must be Execution Market's API origin, https");
  for (const [key, what] of [
    ["CONFIRM_MAINNET_SPEND", "the USDG the buyer pays for the hire (0.25 for a $WIF holder)"],
    ["CONFIRM_MAINNET_BOUNTY", "the USDG the merchant locks in escrow for the worker (EM_BOUNTY_USDG)"],
    ["CONFIRM_MAINNET_REWARD", "the $WIF Flat Fee sends the worker (WIF_WORKER_REWARD)"],
  ] as const) {
    if (!env[key]?.trim()) return no(`mainnet: set ${key} to ${what}, once that exact amount is approved`);
  }

  const mode = (env.WORKER_MODE?.trim().toLowerCase() || "") as WorkerMode;
  if (!MODES.includes(mode)) return no("WORKER_MODE must be manual (a person on execution.market), token (that person's dashboard session) or erc8128 (a wallet the script signs with)");
  let worker: string | null = null;
  if (mode === "erc8128") {
    let key: string | null = null;
    try {
      key = privateKey(env, "WORKER_PRIVATE_KEY");
    } catch (e) {
      return no((e as Error).message);
    }
    if (!key) return no("WORKER_MODE=erc8128 needs WORKER_PRIVATE_KEY, the worker's own wallet");
    if (!env.WORKER_EM_CLIENT?.trim()) {
      return no("WORKER_MODE=erc8128 needs WORKER_EM_CLIENT, the client value the operator approved for the test worker (Flat Fee assigns only people); or use manual or token");
    }
    worker = computeAddress(key);
  } else {
    if (mode === "token" && !env.WORKER_EM_TOKEN?.trim()) return no("WORKER_MODE=token needs WORKER_EM_TOKEN, the worker's Execution Market dashboard session");
    worker = env.WORKER_WALLET?.trim() || null;
    if (!worker || !isAddress(worker)) return no(`WORKER_MODE=${mode} needs WORKER_WALLET, the worker's payout wallet on Execution Market (0x and 40 hex digits)`);
  }
  if (!worker || !isAddress(worker)) return no("the worker's wallet is not an address");
  worker = getAddress(worker.toLowerCase());
  // EM refuses a publisher applying to its own task and an escrow whose payer is its receiver; Flat Fee skips the buyer
  if (sameAddr(worker, payer)) return no("the worker cannot be the buyer (PAYER_PRIVATE_KEY): Flat Fee never assigns the buyer of a task");
  if (sameAddr(worker, cfg.payTo)) return no("the worker cannot be PAY_TO");
  if (cfg.merchantKey && sameAddr(worker, computeAddress(cfg.merchantKey))) return no("the worker cannot be the merchant wallet");

  const minutes = Number(env.E2E_TIMEOUT_MINUTES?.trim() || (mode === "manual" ? "120" : "45"));
  const poll = Number(env.E2E_POLL_SECONDS?.trim() || "5");
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return no("E2E_TIMEOUT_MINUTES must be a number of minutes from 1 to 1440");
  if (!Number.isFinite(poll) || poll < 1 || poll > 300) return no("E2E_POLL_SECONDS must be from 1 to 300");
  const request = env.E2E_REQUEST?.trim() || "Flat Fee end-to-end test: reply with the text this task's test run asks for. Please leave it to the test worker.";
  const answer = env.E2E_ANSWER?.trim() || `Flat Fee e2e answer ${new Date().toISOString().slice(0, 16)}Z`;
  if (request.length > 500) return no("E2E_REQUEST is longer than 500 characters");
  if (Buffer.byteLength(answer, "utf8") > 2000) return no("E2E_ANSWER is longer than 2000 bytes");
  return {
    plan: {
      flatfee,
      emApi,
      mode,
      worker,
      request,
      answer,
      approved: { spend: env.CONFIRM_MAINNET_SPEND!.trim(), bounty: env.CONFIRM_MAINNET_BOUNTY!.trim(), reward: env.CONFIRM_MAINNET_REWARD!.trim(), cashback: env.CONFIRM_MAINNET_WIF?.trim() || null },
      pollMs: poll * 1000,
      timeoutMs: minutes * 60_000,
    },
  };
}

/**
 * Why the running server (`/api/info`) is not the one this run was approved for, or null. On top of e2e:mainnet's
 * checks (remoteRefusal: not a fork, same network, PAY_TO, USDG, $WIF token, holder minimum, cashback and ask prices),
 * it must hire through Execution Market and take a hire right now (its own `hire.available`: the run never pays for a
 * hire the server would refuse), with the approved bounty, worker reward and cashback, the configured hire prices, and
 * `price` (the hire price of the buyer's tier, from the server's quote) equal to CONFIRM_MAINNET_SPEND.
 */
export function remoteHireRefusal(cfg: Config, info: any, plan: HirePlan, price: string | null): string | null {
  const base = remoteRefusal(cfg, info);
  if (base) return base;
  const hire = info?.hire;
  if (hire?.via !== "execution-market") return `FLATFEE_URL hires through ${String(hire?.via ?? "nothing").slice(0, 40)}, not Execution Market (EM_HIRE is off there): refusing`;
  if (hire.available !== true) {
    const why = typeof hire.paused?.reason === "string" ? hire.paused.reason.slice(0, 200) : "it does not say why";
    return `FLATFEE_URL is not taking hires right now (${why}): refusing before anyone pays`;
  }
  const eq = (got: unknown, approved: string | null, decimals: number) => {
    if (approved === null || typeof got !== "string") return false;
    try {
      return parseUnitsStrict(got, decimals) === parseUnitsStrict(approved, decimals);
    } catch {
      return false;
    }
  };
  if (!eq(hire.bounty, plan.approved.bounty, USDG_DECIMALS)) return `FLATFEE_URL locks ${String(hire.bounty).slice(0, 20)} USDG per hire, CONFIRM_MAINNET_BOUNTY is ${plan.approved.bounty}: refusing`;
  const reward = info.wif?.workerReward;
  if (typeof reward !== "string" || /^0*(\.0*)?$/.test(reward)) return "FLATFEE_URL sends no $WIF to the worker (WIF_WORKER_REWARD is 0 there): this run checks that leg, refusing";
  if (!eq(reward, plan.approved.reward, WIF_DECIMALS)) return `FLATFEE_URL sends the worker ${reward.slice(0, 20)} $WIF, CONFIRM_MAINNET_REWARD is ${plan.approved.reward}: refusing`;
  if (cfg.wif.cashback > 0n && !confirms(plan.approved.cashback, cfg.wif.cashback, WIF_DECIMALS)) {
    return `the buyer gets ${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} $WIF cashback: re-run with CONFIRM_MAINNET_WIF=${formatUnits(cfg.wif.cashback, WIF_DECIMALS)} once that amount is approved`;
  }
  const prices: [string, unknown, bigint][] = [
    ["hire price", info.prices?.hire?.standard, cfg.prices.hire],
    ["holder hire price", info.prices?.hire?.holder, cfg.prices.hireHolder],
  ];
  for (const [what, got, want] of prices) {
    if (got !== formatUnits(want, USDG_DECIMALS)) return `FLATFEE_URL serves ${what} ${String(got).slice(0, 20)}, this run expects ${formatUnits(want, USDG_DECIMALS)}: refusing`;
  }
  if (!eq(price, plan.approved.spend, USDG_DECIMALS)) return `the buyer would pay ${String(price).slice(0, 20)} USDG for this hire; CONFIRM_MAINNET_SPEND is ${plan.approved.spend}: refusing`;
  return null;
}

// ------------------------------------------------------------------------------------------------------- the run
export interface Balances {
  usdg(owner: string): Promise<bigint>;
  wif(owner: string): Promise<bigint>;
}

export interface HireDeps {
  /** a request to the running Flat Fee, by path */
  flatfee(path: string): Promise<unknown>;
  /** pays POST /api/hire over x402 (scripts/lib/buyer.ts buy), with the approved amount */
  pay(body: { request: string }): Promise<{ status: number; body: Record<string, any> }>;
  /** the worker on Execution Market; null when a person applies and delivers by hand (WORKER_MODE=manual) */
  worker: {
    apply(taskId: string): Promise<{ status: number; body: unknown }>;
    submit(taskId: string, text: string): Promise<{ status: number; body: unknown }>;
    /** the task as Execution Market shows it to the worker, read once at the end (best effort) */
    task?(taskId: string): Promise<unknown>;
  } | null;
  balances: Balances;
  payer: string;
  payTo: string;
  /** the merchant wallet, which locks the escrow (PAY_TO itself in the deploy's one-wallet setup) */
  merchant: string;
  explorerTx(hash: string): string;
  /** EM's fee bounds for the escrow (payment-config: escrow.max_fee_bps, fee_pct), to check the worker's payout */
  fees: { maxBps: number; pct: number | null };
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface Seen {
  at: string;
  /** flatfee: the task as GET /api/tasks/:id shows it (em.status is Execution Market's, as Flat Fee read it); worker: EM's answer to the worker */
  source: "flatfee" | "worker" | "chain";
  what: string;
  tx?: string;
}

export interface HireOutcome {
  ok: boolean;
  problems: string[];
  taskId: string | null;
  emTaskId: string | null;
  txs: { settle: string | null; cashback: string | null; escrow: string | null; payment: string | null; reward: string | null };
  seen: Seen[];
  deltas: { payerUsdg: bigint; payToUsdg: bigint; merchantUsdg: bigint; workerUsdg: bigint; workerWif: bigint; payerWif: bigint } | null;
}

/**
 * What to do when Execution Market refused the publish for this server's settings or identity (hiring is paused on the
 * server from then on: src/emhire.ts publishRefusal), or null for any other end.
 */
export function publishHint(lastError: string): string | null {
  if (/invalid_reputation_network/i.test(lastError)) {
    return "Execution Market refused reputation_network for the task (EM_REPUTATION_NETWORK): turn EM_HIRE off on the deploy, or set EM_REPUTATION_NETWORK empty; hiring is paused there until then";
  }
  if (/identity_required/i.test(lastError)) {
    return "the merchant wallet has no ERC-8004 identity on Base: run npm run em:register (once), then redeploy; hiring is paused there until then";
  }
  return null;
}

/** the task's fields the run follows, as one line: a change of any of them is a new entry in the timeline */
function snapshot(t: any): string {
  const e = t?.em ?? {};
  return [
    `status=${t?.status}`,
    `em.step=${e.step}`,
    `em.status=${e.status ?? "-"}`,
    e.taskId ? `em.task=${e.taskId}` : null,
    t?.worker ? `worker=${t.worker}` : null,
    e.escrowTx ? `escrowTx=${e.escrowTx}` : null,
    e.paymentTx ? `paymentTx=${e.paymentTx}` : null,
    t?.rewardTx ? `rewardTx=${t.rewardTx}` : null,
    t?.rewardError ? `rewardError=${String(t.rewardError).slice(0, 120)}` : null,
    e.rejected?.length ? `rejected=${e.rejected.length}` : null,
    e.lastError ? `lastError=${String(e.lastError).slice(0, 160)}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function runHire(plan: HirePlan, cfg: Config, d: HireDeps): Promise<HireOutcome> {
  const seen: Seen[] = [];
  const problems: string[] = [];
  const txs: HireOutcome["txs"] = { settle: null, cashback: null, escrow: null, payment: null, reward: null };
  const stamp = () => new Date(d.now()).toISOString();
  const note = (source: Seen["source"], what: string, tx?: string) => {
    seen.push({ at: stamp(), source, what, ...(tx ? { tx } : {}) });
    d.log(`${stamp()}  ${source.padEnd(7)} ${what}${tx ? `  ${d.explorerTx(tx)}` : ""}`);
  };
  const out = (ok: boolean, taskId: string | null, emTaskId: string | null, deltas: HireOutcome["deltas"] = null): HireOutcome => ({ ok, problems, taskId, emTaskId, txs, seen, deltas });
  const cashback = cfg.wif.cashback;
  const reward = parseUnitsStrict(plan.approved.reward, WIF_DECIMALS);
  const bounty = parseUnitsStrict(plan.approved.bounty, USDG_DECIMALS);
  const price = parseUnitsStrict(plan.approved.spend, USDG_DECIMALS);

  const oneWallet = sameAddr(d.merchant, d.payTo);

  // the server's own word, read again right before paying: a run never pays for a hire it would refuse
  let info: any = null;
  try {
    info = await d.flatfee("/api/info");
  } catch (e) {
    problems.push(`cannot read /api/info before paying: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return out(false, null, null);
  }
  if (info?.hire?.via !== "execution-market" || info.hire.available !== true) {
    problems.push(`the server is not taking hires through Execution Market right now (${String(info?.hire?.paused?.reason ?? info?.hire?.via ?? "no answer").slice(0, 160)}): nothing paid`);
    return out(false, null, null);
  }

  const before = { payerUsdg: await d.balances.usdg(d.payer), payToUsdg: await d.balances.usdg(d.payTo), merchantUsdg: await d.balances.usdg(d.merchant), workerUsdg: await d.balances.usdg(plan.worker), workerWif: await d.balances.wif(plan.worker), payerWif: await d.balances.wif(d.payer) };
  note("chain", `before: buyer ${formatUnits(before.payerUsdg, USDG_DECIMALS)} USDG, ${formatUnits(before.payerWif, WIF_DECIMALS)} $WIF; worker ${formatUnits(before.workerUsdg, USDG_DECIMALS)} USDG, ${formatUnits(before.workerWif, WIF_DECIMALS)} $WIF; pay-to ${formatUnits(before.payToUsdg, USDG_DECIMALS)} USDG`);
  if (before.payerUsdg < price) {
    problems.push(`the buyer holds ${formatUnits(before.payerUsdg, USDG_DECIMALS)} USDG, below the ${plan.approved.spend} it would pay`);
    return out(false, null, null);
  }

  // 1. the buyer pays the hire over x402
  const r = await d.pay({ request: plan.request });
  const receipt = r.body?.receipt ?? {};
  txs.settle = isTx(receipt.settleTx) ? receipt.settleTx : null;
  note("flatfee", `POST /api/hire: HTTP ${r.status}${r.body?.error ? ` ${String(r.body.error).slice(0, 200)}` : ""}`, txs.settle ?? undefined);
  const taskId = typeof r.body?.task?.id === "string" ? r.body.task.id : null;
  if (r.status !== 201 || !taskId) {
    problems.push(`the hire was not taken: HTTP ${r.status}`);
    return out(false, taskId, null);
  }
  if (isTx(receipt.cashback?.tx)) txs.cashback = receipt.cashback.tx;

  // 2. follow the task on Flat Fee until `done`, the worker applying and delivering on the way
  const deadline = d.now() + plan.timeoutMs;
  let last = "";
  let task: any = r.body.task;
  let emTaskId: string | null = null;
  let applied = false;
  let delivered = false;
  const follow = async () => {
    task = await d.flatfee(`/api/tasks/${encodeURIComponent(taskId)}`);
    const line = snapshot(task);
    if (line !== last) {
      last = line;
      note("flatfee", line);
    }
  };
  for (;;) {
    try {
      await follow();
    } catch (e) {
      note("flatfee", `GET /api/tasks/${taskId} failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
    const e = task?.em ?? {};
    if (typeof e.taskId === "string") emTaskId = e.taskId;
    if (task?.status === "expired" || e.step === "failed" || e.step === "expired") {
      const why = String(e.lastError ?? "no reason given");
      problems.push(`the task ended ${e.step ?? task?.status} on Flat Fee: ${why.slice(0, 200)}`);
      const hint = publishHint(why);
      if (hint) problems.push(hint);
      break;
    }
    if (task?.status === "done") break;
    // someone else got the task: nothing is delivered for it; it finishes (or expires) without this run
    if (task?.worker && !sameAddr(task.worker, plan.worker)) {
      problems.push(`Flat Fee assigned another applicant (${task.worker}), not the test worker: nothing delivered, stopping`);
      break;
    }
    if (emTaskId && !applied) {
      applied = true;
      if (d.worker) {
        try {
          const a = await d.worker.apply(emTaskId);
          note("worker", `POST /api/v1/tasks/${emTaskId}/apply: HTTP ${a.status}`);
        } catch (err) {
          note("worker", `apply refused: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
          problems.push("Execution Market did not take the worker's application");
          break;
        }
      } else {
        d.log(`\n>>> on execution.market, as the worker ${plan.worker}: apply to task ${emTaskId}, then, once it is assigned, deliver this text answer exactly:\n>>> ${plan.answer}\n`);
      }
    }
    // the escrow locked for our worker: EM takes a delivery once the task is accepted
    const locked = sameAddr(task?.worker, plan.worker) && ["accepted", "in_progress"].includes(String(e.status));
    if (locked && !delivered) {
      delivered = true;
      if (d.worker) {
        try {
          const s = await d.worker.submit(emTaskId!, plan.answer);
          note("worker", `POST /api/v1/tasks/${emTaskId}/submit (text_response): HTTP ${s.status}`);
        } catch (err) {
          note("worker", `delivery refused: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
          problems.push("Execution Market did not take the worker's delivery");
          break;
        }
      }
    }
    if (d.now() >= deadline) {
      problems.push(`timed out after ${Math.round(plan.timeoutMs / 60_000)} min with the task ${snapshot(task)}${applied && !task?.worker ? " (the worker applied but was never assigned)" : ""}`);
      break;
    }
    await d.sleep(plan.pollMs);
  }

  // Flat Fee marks the task done before it sends the worker's $WIF and records its hash (src/emhire.ts finish): a read
  // in between has no reward yet, so keep reading until the reward or its error is there
  if (task?.status === "done" && reward > 0n) {
    for (let i = 0; i < Math.ceil(180_000 / plan.pollMs) && !isTx(task?.rewardTx) && !task?.rewardError; i++) {
      await d.sleep(plan.pollMs);
      try {
        await follow();
      } catch {
        // read again
      }
    }
  }

  // Flat Fee stops reading a task once it closed it, so EM's own last status comes from EM, as the worker sees it
  let emPaymentTx: string | null = null;
  if (emTaskId && d.worker?.task) {
    try {
      const t = (await d.worker.task(emTaskId)) as Record<string, unknown> | null;
      if (isTx(t?.payment_tx)) emPaymentTx = t!.payment_tx as string;
      const f = (k: string) => (typeof t?.[k] === "string" ? `${k}=${String(t[k]).slice(0, 80)}` : null);
      note("worker", `GET /api/v1/tasks/${emTaskId}: ${["status", "escrow_status", "escrow_tx", "payment_tx"].map(f).filter(Boolean).join(" ") || "no status"}`);
    } catch (err) {
      note("worker", `GET /api/v1/tasks/${emTaskId} failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`);
    }
  }

  const e = task?.em ?? {};
  txs.escrow = isTx(e.escrowTx) ? e.escrowTx : null;
  txs.payment = isTx(e.paymentTx) ? e.paymentTx : emPaymentTx;
  txs.reward = isTx(task?.rewardTx) ? task.rewardTx : null;
  if (txs.escrow) note("chain", "escrow locked (the merchant's bounty)", txs.escrow);
  if (txs.payment) note("chain", "escrow released to the worker", txs.payment);
  if (txs.reward) note("chain", `$WIF reward to the worker`, txs.reward);

  // the cashback a server answered "pending" for lands in its ledger
  if (cashback > 0n && !txs.cashback && txs.settle) {
    for (let i = 0; i < 20 && !txs.cashback; i++) {
      try {
        const c = ledgerCashback(await d.flatfee("/api/ledger"), txs.settle);
        if (c?.tx) txs.cashback = c.tx;
        else if (c?.error) {
          problems.push(`the server recorded a cashback error: ${c.error.slice(0, 200)}`);
          break;
        }
      } catch {
        // try again
      }
      if (!txs.cashback) await d.sleep(3_000);
    }
  }
  if (txs.cashback) note("chain", "$WIF cashback to the buyer", txs.cashback);
  if (task?.status !== "done") return out(false, taskId, emTaskId);

  // 3. what the chain says: the RPC may answer from a block before the server's last receipt, so read until it moved
  const read = async () => ({
    payerUsdg: (await d.balances.usdg(d.payer)) - before.payerUsdg,
    payToUsdg: (await d.balances.usdg(d.payTo)) - before.payToUsdg,
    merchantUsdg: (await d.balances.usdg(d.merchant)) - before.merchantUsdg,
    workerUsdg: (await d.balances.usdg(plan.worker)) - before.workerUsdg,
    workerWif: (await d.balances.wif(plan.worker)) - before.workerWif,
    payerWif: (await d.balances.wif(d.payer)) - before.payerWif,
  });
  let deltas = await read();
  for (let i = 0; i < 10 && (deltas.workerUsdg <= 0n || deltas.workerWif < reward || (cashback > 0n && deltas.payerWif < cashback)); i++) {
    await d.sleep(3_000);
    deltas = await read();
  }
  note("chain", `after: buyer ${formatUnits(deltas.payerUsdg, USDG_DECIMALS)} USDG, ${formatUnits(deltas.payerWif, WIF_DECIMALS)} $WIF; worker +${formatUnits(deltas.workerUsdg, USDG_DECIMALS)} USDG, +${formatUnits(deltas.workerWif, WIF_DECIMALS)} $WIF; pay-to ${formatUnits(deltas.payToUsdg, USDG_DECIMALS)} USDG${oneWallet ? " (the merchant)" : `; merchant ${formatUnits(deltas.merchantUsdg, USDG_DECIMALS)} USDG`}`);

  // 4. the verdict
  if (typeof task.answer !== "string" || task.answer.trim() !== plan.answer) problems.push("the buyer's answer on Flat Fee is not the text the worker delivered");
  if (!txs.settle) problems.push("no settlement transaction for the buyer's payment");
  if (!txs.escrow) problems.push("no escrow transaction on the task");
  if (!txs.payment) problems.push("no escrow release transaction on the task");
  if (!txs.reward) problems.push(`no $WIF reward transaction${task.rewardError ? ` (${String(task.rewardError).slice(0, 160)})` : ""}`);
  if (cashback > 0n && !txs.cashback) problems.push("no $WIF cashback transaction for the buyer");
  if (deltas.payerUsdg !== -price) problems.push(`the buyer's USDG moved ${formatUnits(deltas.payerUsdg, USDG_DECIMALS)}, not -${plan.approved.spend}`);
  // the merchant locked exactly the approved bounty (and PAY_TO got exactly the price): in the one-wallet setup, both in
  // one balance. Another payment to these wallets during the run moves them too: read the txs above before any re-run
  const merchantWant = oneWallet ? price - bounty : -bounty;
  if (deltas.merchantUsdg !== merchantWant) problems.push(`the merchant's USDG moved ${formatUnits(deltas.merchantUsdg, USDG_DECIMALS)}, not ${formatUnits(merchantWant, USDG_DECIMALS)} (${oneWallet ? "the price in, the bounty out to the escrow" : "the bounty out to the escrow"}; any other payment to it during the run counts too)`);
  if (!oneWallet && deltas.payToUsdg !== price) problems.push(`PAY_TO's USDG moved ${formatUnits(deltas.payToUsdg, USDG_DECIMALS)}, not +${plan.approved.spend}`);
  // the worker gets the bounty less EM's fee, never more than the bounty, never less than its largest fee allows
  const least = (bounty * BigInt(10_000 - d.fees.maxBps)) / 10_000n;
  if (deltas.workerUsdg > bounty || deltas.workerUsdg < least) problems.push(`the worker's USDG moved +${formatUnits(deltas.workerUsdg, USDG_DECIMALS)}, outside ${formatUnits(least, USDG_DECIMALS)}..${plan.approved.bounty} (the bounty less EM's fee)`);
  if (d.fees.pct !== null) {
    const fee = (bounty * BigInt(Math.round(d.fees.pct * 10_000))) / 10_000n;
    note("chain", `EM fee ${Math.round(d.fees.pct * 10_000) / 100}%: the worker should get about ${formatUnits(bounty - fee, USDG_DECIMALS)} USDG of the ${plan.approved.bounty} bounty`);
  }
  if (deltas.workerWif !== reward) problems.push(`the worker's $WIF moved +${formatUnits(deltas.workerWif, WIF_DECIMALS)}, not +${plan.approved.reward}`);
  if (cashback > 0n && deltas.payerWif !== cashback) problems.push(`the buyer's $WIF moved +${formatUnits(deltas.payerWif, WIF_DECIMALS)}, not the +${formatUnits(cashback, WIF_DECIMALS)} cashback`);
  return out(problems.length === 0, taskId, emTaskId, deltas);
}
