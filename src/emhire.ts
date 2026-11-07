// Hire a human through Execution Market (EM_HIRE=on). Flat Fee acts as an agent there: it publishes the task the buyer
// paid for, assigns the first eligible applicant while the merchant pays the bounty into a USDG escrow, reviews the
// delivery, approves it (the escrow pays the worker) or rejects it with the reason, then sends the worker the $WIF
// reward and keeps the answer for the buyer. A loop drives every open hire from its status on Execution Market, so a
// step that failed (EM unreachable, a timeout) is simply tried again on the next pass.
import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "ethers";
import { WifTransferUnconfirmed } from "./chain.js";
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, type Config, type EmConfig } from "./config.js";
import { EmHttpError, emId, txHash, type EmApi, type EmApplication, type EmSubmission, type EmTask } from "./em.js";
import { emPublishRefusal, unpublishableText } from "./emguard.js";
import type { SignedEscrow } from "./escrow.js";
import type { EmTaskState, Store, Task } from "./store.js";
import type { SendWif } from "./wif.js";

/** the longest text answer Flat Fee accepts from a worker, in bytes (EM measures deliveries in bytes) */
export const MAX_ANSWER_BYTES = 2000;
/** a text_response sent as an object ({type, value}) is measured with its wrapper: this much room for it */
const WRAPPER_BYTES = 256;
/** approvals sent for one task before Flat Fee stops and leaves it to a person */
export const MAX_APPROVALS = 3;

const TERMINAL = new Set<EmTaskState["step"]>(["completed", "expired", "failed"]);
/** the executor kinds Flat Fee hires: a person, directly or through an agent (EM's `human_via_agent`); none given counts as a person */
const HUMAN = new Set(["", "human", "human_via_agent"]);
/** steps whose escrow has not landed yet: each one still needs a bounty from the merchant wallet */
const UNFUNDED = new Set<EmTaskState["step"]>(["publishing", "published", "assigning"]);
/** the longest title, in code points, cut from the buyer's request */
export const TITLE_CODE_POINTS = 80;
/**
 * EM's refusals of one task for its own text (a675eb6: services/sell_intent.py, secret_guard.py, content_review.py):
 * the next buyer's task is not refused for them, so they end that task and do not pause hiring
 */
const TEXT_REFUSALS = new Set(["sell_intent_rejected", "embedded_secret_rejected", "task_content_rejected", "task_content_too_large"]);
/** the fields of a publish that carry the buyer's request: a validation 422 on these alone is about that one task */
const TEXT_FIELDS = new Set(["title", "instructions"]);
/** the task's escrow went back to the merchant (EM's escrow states: refunding, refunded) */
const REFUNDED = new Set(["refunding", "refunded"]);

/**
 * What Flat Fee does with a publish EM did not take: send it again later (unreachable, busy, or a refusal EM marks
 * `retryable`), end only this task (a refusal of its text, or a 409 on its own key), or end it and pause hiring (any
 * other refusal is about this server's settings or identity, and would refuse the next buyer's task too).
 */
export function publishRefusal(e: unknown): "retry" | "task" | "pause" {
  if (!(e instanceof EmHttpError) || e.retryable) return "retry";
  // EM's typed refusals carry `error` in snake_case and `code` as its UPPER twin: either one names them
  if (e.code && TEXT_REFUSALS.has(e.code.toLowerCase())) return "task";
  if (e.status === 409) return "task";
  if (e.status === 422 && !e.code && e.fields.length && e.fields.every((f) => TEXT_FIELDS.has(f))) return "task";
  return "pause";
}

export interface EmHireDeps {
  cfg: Config & { em: EmConfig };
  store: Store;
  api: EmApi;
  sendWif: SendWif;
  /** the merchant wallet's address: never assigned as a worker */
  merchant: string;
  /** signs the escrow lock for `worker` from EM's published escrow parameters (src/escrow.ts escrowPaymentAuth) */
  paymentAuth: (paymentConfig: unknown, worker: string, deadlineSec: number) => Promise<SignedEscrow>;
  /** the payer's release order for an escrow, from the paymentInfo it was signed with (src/escrow.ts releaseOrder) */
  releaseOrder: (paymentInfo: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** why EM's published escrow parameters cannot carry a hire now, or null (src/escrow.ts escrowReadiness) */
  ready: (paymentConfig: unknown) => Promise<string | null>;
  /** the merchant wallet's USDG, which pays every escrow */
  usdgBalance: () => Promise<bigint>;
  log?: (msg: string) => void;
  now?: () => Date;
  /** how an error is written into the task and the log (no URLs, no keys) */
  redact?: (e: unknown) => string;
}

/**
 * Why new hires are refused before their 402, by kind: Execution Market not reached yet (`unchecked`), its escrow on
 * this network cannot carry a hire (`escrow`), it refused this server's last publish for its settings or identity
 * (`refused`), or the merchant wallet cannot fund one more escrow (`funds`).
 */
export type HirePauseKind = "unchecked" | "escrow" | "refused" | "funds";

export interface HirePause {
  kind: HirePauseKind;
  /** the full reason, for the 503 and the log; it can carry EM's words, a wallet or an amount */
  detail: string;
}

/**
 * What /api/info (and so the landing page) says about a pause: one fixed sentence per kind, with no wallet, amount,
 * contract or error text in it. The detail stays in the 503 and the server log.
 */
export function publicPause(kind: HirePauseKind, chainLabel: string): string {
  switch (kind) {
    case "unchecked":
      return "Flat Fee has not reached Execution Market yet.";
    case "escrow":
      return `Execution Market's escrow on ${chainLabel} cannot take a hire right now.`;
    case "refused":
      return "Execution Market refused this server's last task; hiring waits for the operator.";
    case "funds":
      return "The wallet that pays the escrow cannot fund one more task right now.";
  }
}

/**
 * What becomes of a hire nobody finishes, as /api/info and the 201 of /api/hire tell the buyer: what this code does
 * (onPublished cancels a task nobody was assigned by its deadline, before anything is locked; a task EM expires after
 * an assignment ends expired, and EM sends its locked escrow back to the merchant) and nothing more. No refund either way.
 */
export function hireExpiry(deadlineHours: number): string {
  return (
    `The task is on Execution Market, for any of its people to take. If no one takes it within ${deadlineHours} h, it expires ` +
    "and Flat Fee cancels it there: nothing was locked for it. If the person who takes it does not deliver by then, " +
    "Execution Market returns the escrowed pay to Flat Fee's wallet. Either way, the fee you paid is not refunded."
  );
}

export interface EmHire {
  /** why a new hire is refused before its 402 (Execution Market cannot take it, or the merchant cannot fund it); null when it can run */
  unavailable(): HirePause | null;
  /** why Execution Market would refuse to publish this request (its own rules, on the exact task text), or null */
  refuses(request: string): string | null;
  /** checks EM's escrow for this network and the merchant's USDG again (each pass does) */
  refresh(): Promise<void>;
  /** publishes a new hire now; a failure is kept on the task and the loop tries again */
  publish(taskId: string): Promise<void>;
  /** one pass over every open hire */
  tick(): Promise<void>;
  /** runs a pass now and every EM_POLL_SECONDS; returns the stop */
  start(): () => void;
}

export function newEmState(at: Date): EmTaskState {
  return {
    step: "publishing",
    key: `flatfee-${randomUUID()}`,
    taskId: null,
    status: null,
    deadline: null,
    executorId: null,
    workerWallet: null,
    escrowTx: null,
    skipped: [],
    signed: [],
    accepted: null,
    approvals: 0,
    needsOrder: false,
    assignedAt: null,
    rejected: [],
    approval: null,
    paymentTx: null,
    lastError: null,
    updatedAt: at.toISOString(),
  };
}

/** what of a task's Execution Market state is public (GET /api/tasks): no signed escrows, no executor ids */
export function publicEm(e: EmTaskState | undefined) {
  if (!e) return undefined;
  return {
    step: e.step,
    taskId: e.taskId,
    status: e.status,
    deadline: e.deadline,
    escrowTx: e.escrowTx,
    paymentTx: e.paymentTx,
    rejected: e.rejected.map((r) => r.reason),
    lastError: e.lastError,
  };
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** why the delivery cannot be accepted, read from EM's manifest (what it holds, never what it says); null when it can */
export function manifestProblem(s: EmSubmission): string | null {
  const items = s.evidence_manifest?.items;
  if (!Array.isArray(items)) return null; // no manifest: the text itself is checked once opened
  const text = items.find((i) => i?.field === "text_response");
  if (!text) return "No text_response in the delivery: write the answer as text (text_response).";
  const size = typeof text.size_bytes === "number" ? text.size_bytes : null;
  if (size !== null && size <= 0) return "The text_response is empty: write the answer as text.";
  // a plain string is measured as is; an object ({type, value}) with its wrapper, so it gets some room
  const limit = text.type === "text" ? MAX_ANSWER_BYTES : MAX_ANSWER_BYTES + WRAPPER_BYTES;
  if (size !== null && size > limit) return `The text_response is longer than ${MAX_ANSWER_BYTES} bytes: keep the answer short.`;
  return null;
}

/** the worker's text answer out of the opened evidence, trimmed; null when there is none or it is too long */
export function answerOf(evidence: unknown): string | null {
  const v = (evidence as Record<string, unknown> | null)?.text_response;
  const raw =
    typeof v === "string"
      ? v
      : v && typeof v === "object"
        ? [(v as Record<string, unknown>).value, (v as Record<string, unknown>).text, (v as Record<string, unknown>).content].find((x): x is string => typeof x === "string")
        : undefined;
  const t = raw?.trim();
  if (!t || Buffer.byteLength(t, "utf8") > MAX_ANSWER_BYTES) return null;
  return t;
}

export function createEmHire({
  cfg,
  store,
  api,
  sendWif,
  merchant,
  paymentAuth,
  releaseOrder,
  ready,
  usdgBalance,
  log = console.log,
  now = () => new Date(),
  redact = (e) => (e as Error)?.message ?? String(e),
}: EmHireDeps): EmHire {
  const em = cfg.em;
  const nowSec = () => Math.floor(now().getTime() / 1000);

  // one step at a time per task: the paid request's publish and the loop never act on the same task at once
  const locks = new Map<string, Promise<void>>();
  const serial = (id: string, fn: () => Promise<void>): Promise<void> => {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return run;
  };

  const save = (t: Task, patch: Partial<EmTaskState>, task: Partial<Task> = {}) => {
    store.updateTask(t.id, { ...task, em: { ...t.em!, ...patch, updatedAt: now().toISOString() } });
  };
  const record = (t: Task, e: unknown) => {
    const msg = typeof e === "string" ? e : redact(e);
    if (t.em?.lastError !== msg) log(`hire ${t.id} on Execution Market: ${msg}`);
    save(t, { lastError: msg });
  };
  const end = (t: Task, step: "expired" | "failed", why: string) => {
    log(`hire ${t.id} ${step}: ${why}`);
    save(t, { step, lastError: why }, { status: "expired" });
  };

  /** when the task must be taken by: EM's deadline once known, else the one Flat Fee asked for */
  const deadlineOf = (t: Task): number => {
    const d = Date.parse(t.em?.deadline ?? "");
    return Number.isFinite(d) ? d : Date.parse(t.createdAt) + em.deadlineHours * 3_600_000;
  };
  const late = (t: Task) => now().getTime() >= deadlineOf(t);

  // ------------------------------------------------------------------------------------------------- readiness
  // Until a first check answers, nobody pays for a hire. An unreachable EM or RPC later keeps the last answer (a hire
  // paid then is published by the loop once EM answers again); a refusal from EM does not.
  let configProblem: string | null = "Execution Market has not been checked yet";
  // false until a check answered: EM (or the RPC) unreachable since boot leaves nothing known about EM's escrow
  let checked = false;
  let balance: bigint | null = null;
  // EM refused a publish outright: hiring stays paused, across restarts (state.json), until a publish goes through
  // again or the EM settings change (the operator fixed something on this side)
  const settings = JSON.stringify({ api: em.apiUrl, network: cfg.chain.name, bounty: em.bounty.toString(), token: em.paymentToken, escrow: em.escrow, deadline: em.deadlineHours });
  const publishRefused = (): string | null => {
    const p = store.emPause();
    return p && p.config === settings ? p.reason : null;
  };

  const refresh = async () => {
    let why: string | null;
    try {
      why = await ready(await api.paymentConfig());
    } catch (e) {
      if (e instanceof EmHttpError && !e.retryable) why = `Execution Market refused to show its escrow parameters (${redact(e)})`;
      else {
        log(`Execution Market check failed: ${redact(e)}`);
        return;
      }
    }
    try {
      balance = await usdgBalance();
    } catch (e) {
      log(`merchant USDG read failed: ${redact(e)}`);
    }
    const pause = store.emPause();
    if (pause && pause.config !== settings) {
      log("hiring resumes: the Execution Market settings changed since EM refused a task");
      store.setEmPause(null);
    }
    if (why !== configProblem) log(why ? `hiring paused: ${why}` : "Execution Market can take hires on this network");
    configProblem = why;
    checked = true;
  };

  const unavailable = (): HirePause | null => {
    if (configProblem) return { kind: checked ? "escrow" : "unchecked", detail: configProblem };
    const refused = publishRefused();
    if (refused) return { kind: "refused", detail: refused };
    // every hire whose escrow has not landed yet still needs a bounty from the merchant, and so does the next one
    const unfunded = store.tasks().filter((t) => t.via === "em" && t.em && UNFUNDED.has(t.em.step)).length;
    const needed = em.bounty * BigInt(unfunded + 1);
    if (balance === null || balance < needed) {
      return { kind: "funds", detail: `the merchant wallet cannot fund one more escrow (${formatUnits(needed, USDG_DECIMALS)} USDG needed for the open hires)` };
    }
    return null;
  };

  // ------------------------------------------------------------------------------------------------- publish
  /** the title and instructions a request is published with; the check before the 402 reads the same */
  function taskText(request: string): { title: string; instructions: string } {
    const oneLine = request.replace(/\s+/g, " ").trim();
    const reward = cfg.wif.workerReward > 0n ? ` Flat Fee then sends you ${formatUnits(cfg.wif.workerReward, WIF_DECIMALS)} $WIF on ${cfg.chain.label} on top of the bounty.` : "";
    return {
      // cut by code points, so an emoji at the cut is kept whole or left out, never split into a lone surrogate
      title: `Flat Fee: ${Array.from(oneLine).slice(0, TITLE_CODE_POINTS).join("")}`,
      instructions: `${request}\n\nDeliver your answer as text (text_response), at most ${MAX_ANSWER_BYTES} bytes. Flat Fee reviews it and approves it, which releases the escrowed bounty to you.${reward}`,
    };
  }

  const refuses = (request: string): string | null => {
    const bad = unpublishableText(request);
    if (bad) return bad;
    const { title, instructions } = taskText(request);
    return emPublishRefusal(title, instructions);
  };

  async function publishNow(t: Task) {
    if (late(t)) return end(t, "failed", "could not publish on Execution Market before the deadline");
    const body: Record<string, unknown> = {
      ...taskText(t.request),
      category: "simple_action",
      bounty_usd: Number(formatUnits(em.bounty, USDG_DECIMALS)),
      deadline_hours: em.deadlineHours,
      evidence_required: ["text_response"],
      payment_network: cfg.chain.name,
      payment_token: em.paymentToken,
      target_executor: "human",
      agent_name: "Flat Fee",
      ...(em.reputationNetwork ? { reputation_network: em.reputationNetwork } : {}),
    };
    try {
      // one key per hire, kept with it: a publish sent again (a timeout, a restart) never makes a second task on EM
      const r = await api.createTask(body, t.em!.key);
      save(t, { step: "published", taskId: r.id, status: r.status ?? null, deadline: typeof r.deadline === "string" ? r.deadline : null, lastError: null });
      if (store.emPause()) store.setEmPause(null);
      log(`hire ${t.id} published on Execution Market as ${r.id}`);
    } catch (e) {
      const kind = publishRefusal(e);
      // nothing was created on EM: the same publish, with the same key, goes out again on the next pass
      if (kind === "retry") return record(t, e);
      const why = `Execution Market refused the task: ${redact(e)}`;
      // a refusal of this task's own text or key ends this task only; any other would refuse the next buyer's task
      // too, so payments stop until a publish goes through again or the EM settings change
      if (kind === "pause") store.setEmPause({ reason: `hiring is paused since ${why}`, config: settings, at: now().toISOString() });
      return end(t, "failed", why);
    }
  }

  // ------------------------------------------------------------------------------------------------- assign
  /** the applicants Flat Fee would assign, best first: EM's ranking, never one EM flagged, a non-human, the buyer, the merchant or one that failed */
  function eligible(t: Task, apps: EmApplication[]): { executorId: string; wallet: string }[] {
    const ok = apps.filter((a) => {
      if (a?.status !== "pending" || typeof a.executor_id !== "string") return false;
      if (typeof a.wallet_address !== "string" || !isAddress(a.wallet_address)) return false;
      if (sameAddress(a.wallet_address, t.payer) || sameAddress(a.wallet_address, merchant)) return false;
      if (a.review || a.recommended === false) return false;
      // Flat Fee sells a human's time: only an applicant that applied as a human (directly or through an agent) is taken
      if (!HUMAN.has(String(a.executor_type ?? "")) || !HUMAN.has(String(a.executor_kind ?? ""))) return false;
      return !t.em!.skipped.includes(a.executor_id.toLowerCase());
    });
    ok.sort(
      (a, b) =>
        (b.effective_reputation_score ?? 0) - (a.effective_reputation_score ?? 0) ||
        (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0),
    );
    const out: { executorId: string; wallet: string }[] = [];
    for (const a of ok) {
      try {
        out.push({ executorId: emId(a.executor_id, "executor id"), wallet: getAddress(a.wallet_address!.toLowerCase()) });
      } catch {
        // not a UUID: never put into a path
      }
    }
    return out;
  }

  async function onPublished(t: Task, remote: EmTask) {
    const e = t.em!;
    if (e.step === "assigning" && e.executorId) {
      // a failure recorded before this assignment was sent is an older attempt's, not this applicant's
      const f = remote.escrow_lock_failure;
      const fAt = Date.parse(f?.at ?? "");
      const sentAt = Date.parse(e.assignedAt ?? "");
      if (f && !(Number.isFinite(fAt) && Number.isFinite(sentAt) && fAt < sentAt)) {
        // EM tried to lock and put the task back. That applicant is not tried again, unless EM says the failure was
        // not theirs (then the same authorization is sent again).
        const why = redact(String(f.reason ?? f.code ?? "the escrow lock did not land")).slice(0, 200);
        const skipped = f.retryable === true ? e.skipped : [...e.skipped, e.executorId];
        save(t, { step: "published", skipped, executorId: null, workerWallet: null, lastError: `escrow lock failed: ${why}` });
        log(`hire ${t.id}: escrow lock failed (${why})`);
      } else {
        // the assignment never reached EM: the same authorization goes to the same applicant again
        save(t, { step: "published", executorId: null, workerWallet: null });
      }
    } else if (e.step !== "published") {
      save(t, { step: "published" }, { status: "open", worker: null });
    }
    if (late(t)) {
      await api.cancel(e.taskId!, "Nobody was assigned before the deadline.");
      return end(t, "expired", "nobody took the task before its deadline; cancelled on Execution Market, nothing was locked");
    }
    const candidates = eligible(t, await api.applications(e.taskId!));
    if (!candidates.length) return;
    // An authorization the merchant signed can be used until its validBefore. It is sent again to its own applicant
    // rather than signed anew, and no other applicant gets one until it can no longer be used: two live escrow
    // authorizations for one task could both lock.
    const live = t.em!.signed.filter((s) => s.validBefore > nowSec());
    const reuse = candidates.find((c) => live.some((s) => s.executorId === c.executorId));
    if (live.length && !reuse) {
      const until = new Date(Math.max(...live.map((s) => s.validBefore)) * 1000).toISOString();
      return record(t, `waiting until ${until}, when the last escrow authorization expires, before signing one for another applicant`);
    }
    const pick = reuse ?? candidates[0];
    let signed = live.find((s) => s.executorId === pick.executorId);
    if (!signed) {
      const fresh = await paymentAuth(await api.paymentConfig(), pick.wallet, Math.floor(deadlineOf(t) / 1000));
      signed = { executorId: pick.executorId, wallet: pick.wallet, ...fresh };
      // kept before it is sent: its paymentInfo is what releases or reclaims the escrow, whatever happens next
      save(t, { signed: [...t.em!.signed, signed] });
    }
    // written down before EM is asked, so the next pass knows whom this pass assigned whatever happens to the call
    save(t, { step: "assigning", executorId: pick.executorId, workerWallet: pick.wallet, assignedAt: now().toISOString(), lastError: null });
    let r: { status: number; workerWallet: string | null };
    try {
      r = await api.assign(e.taskId!, pick.executorId, signed.auth);
    } catch (err) {
      // unreachable, a timeout, a 5xx, or a 409 (EM's state moved): stay "assigning" with this pick; the next pass reads
      // EM's status, and resends this same authorization if the assignment never landed
      if (err instanceof EmHttpError && !err.transient && err.status !== 409) {
        const skip = err.serverRetryable !== true;
        save(t, { step: "published", executorId: null, workerWallet: null, ...(skip ? { skipped: [...t.em!.skipped, pick.executorId] } : {}) });
      }
      throw err;
    }
    if (r.workerWallet && !sameAddress(r.workerWallet, pick.wallet)) {
      log(`hire ${t.id}: Execution Market names another wallet for the worker than the one the escrow pays`);
    }
    if (r.status === 202) return log(`hire ${t.id}: assigned on Execution Market, escrow lock in flight`);
    save(t, { step: "assigned" }, { status: "claimed", worker: pick.wallet });
    log(`hire ${t.id}: assigned to ${pick.wallet}, ${formatUnits(em.bounty, USDG_DECIMALS)} USDG in escrow`);
  }

  /**
   * The escrow that locked for the worker EM assigned: the newest authorization Flat Fee signed for that executor (a
   * new one is only signed once the earlier ones can no longer be used, and each is sent right after it is signed).
   * Null when EM assigned someone Flat Fee signed nothing for.
   */
  const signedFor = (t: Task, executorId: string | null | undefined) =>
    [...t.em!.signed].reverse().find((s) => !!executorId && s.executorId === String(executorId).toLowerCase()) ?? null;

  function onAssigned(t: Task, remote: EmTask) {
    const s = signedFor(t, remote.executor_id);
    if (!s) {
      save(t, { step: "assigned", lastError: "Execution Market assigned an executor Flat Fee signed no escrow for: its delivery is not approved and no $WIF goes out" }, { status: "claimed" });
      return;
    }
    if (t.em!.step === "assigned" && t.em!.executorId === s.executorId) return;
    save(t, { step: t.em!.step === "approving" ? "approving" : "assigned", executorId: s.executorId, workerWallet: s.wallet, lastError: null }, { status: "claimed", worker: s.wallet });
  }

  // ------------------------------------------------------------------------------------------------- review
  async function onSubmitted(t: Task, remote: EmTask) {
    const e = t.em!;
    onAssigned(t, remote);
    if (e.approval) return followApproval(t, remote);
    // the escrow pays whom Flat Fee signed it for: a delivery from anyone else is not approved
    if (!signedFor(t, remote.executor_id)) return;
    const subs = await api.submissions(e.taskId!);
    const open = subs
      .filter((s) => s?.status === "pending" && (s.agent_verdict == null || s.agent_verdict === "pending"))
      .filter((s) => !e.rejected.some((r) => r.submissionId === String(s.id).toLowerCase()))
      .sort((a, b) => (Date.parse(b.submitted_at ?? "") || 0) - (Date.parse(a.submitted_at ?? "") || 0));
    const s = open[0];
    if (!s) return;
    const sid = emId(s.id, "submission id");
    const reject = async (reason: string) => {
      await api.reject(sid, reason);
      save(t, { rejected: [...t.em!.rejected, { submissionId: sid, reason }], lastError: null });
      log(`hire ${t.id}: delivery ${sid} rejected: ${reason}`);
    };
    // Every delivery is opened before Flat Fee decides, a rejection included. EM keeps the escrow of a delivery its
    // publisher read and then rejected (EM-7, on in production), so the worker can deliver again and still be paid;
    // one rejected unread is refunded to the merchant by EM's stranded-escrow sweep within minutes, and nobody could
    // be paid for the next delivery (a675eb6: jobs/stranded_escrow_sweeper.py, api/routers/submissions.py).
    const opened = await api.openEvidence(sid);
    const problem = manifestProblem(s);
    if (problem) return reject(problem);
    const answer = answerOf(opened.evidence);
    if (!answer) return reject(`No readable text answer of at most ${MAX_ANSWER_BYTES} bytes in the delivery: write the answer as text (text_response).`);
    return approve(t, remote, sid, answer);
  }

  /**
   * The escrow of an assigned task went back to the merchant (EM refunded it): nobody can be paid for this task any
   * more. It is cancelled on EM, so no worker is left delivering into it, and ends here, without asking for more work.
   */
  async function onRefunded(t: Task) {
    try {
      await api.cancel(t.em!.taskId!, "The escrow went back to the publisher, so this task can no longer be paid.");
    } catch (e) {
      if (!(e instanceof EmHttpError) || e.retryable) throw e;
      log(`hire ${t.id}: Execution Market did not cancel a task whose escrow it refunded (${redact(e)})`);
    }
    return end(t, "expired", "the escrow went back to the merchant on Execution Market, so no delivery can be paid; the task was closed there");
  }

  async function approve(t: Task, remote: EmTask, sid: string, answer: string | null) {
    if (t.em!.approvals >= MAX_APPROVALS) {
      return record(t, `EM refused the release ${MAX_APPROVALS} times; Flat Fee stopped approving, a person has to look at it`);
    }
    const signed = signedFor(t, remote.executor_id)!;
    save(t, { accepted: sid });
    // the payer's release order (over the escrow that locked) goes along only once EM asks for it: EM checks any
    // order it is sent, so an order it did not need is only another way for the approval to be refused
    const send = async (withOrder: boolean) => api.approve(sid, "Accepted by Flat Fee.", withOrder ? await releaseOrder(signed.paymentInfo) : null);
    let approval;
    try {
      try {
        approval = await send(t.em!.needsOrder);
      } catch (err) {
        if (!(err instanceof EmHttpError && err.code === "LIFECYCLE_ORDER_REQUIRED") || t.em!.needsOrder) throw err;
        save(t, { needsOrder: true });
        approval = await send(true);
      }
    } catch (err) {
      // another approval of this task already runs on EM: follow it instead of approving again
      if (err instanceof EmHttpError && err.poll) {
        save(t, { step: "approving", approval: { submissionId: sid, poll: err.poll } });
        return;
      }
      // only a refusal counts towards the cap: EM unreachable, slow or busy is tried again as often as it takes
      if (err instanceof EmHttpError && (err.status === 502 || (err.status >= 400 && err.status < 500 && err.status !== 429))) {
        save(t, { approvals: t.em!.approvals + 1 });
      }
      throw err;
    }
    if (approval.status === 202) {
      save(t, { step: "approving", approval: { submissionId: sid, poll: approval.poll! }, lastError: null });
      return log(`hire ${t.id}: approval queued on Execution Market`);
    }
    return finish(t, remote, { submissionId: sid, answer }, approval.paymentTx);
  }

  async function followApproval(t: Task, remote: EmTask) {
    const { submissionId, poll } = t.em!.approval!;
    const op = await api.operation(poll);
    if (!op.done) return;
    if (op.state === "succeeded") return finish(t, remote, { submissionId, answer: null }, txHash(op.response?.data?.payment_tx));
    if (op.state === "failed") {
      // EM refused and the escrow still holds the bounty: approved again on a later pass, up to MAX_APPROVALS, with the
      // payer's release order if that is what EM asked for
      const needsOrder = t.em!.needsOrder || JSON.stringify(op.response ?? {}).includes("LIFECYCLE_ORDER_REQUIRED");
      return save(t, { step: "assigned", approval: null, approvals: t.em!.approvals + 1, needsOrder, lastError: "Execution Market could not release the escrow" });
    }
    // unresolved: EM cannot tell what happened to the escrow, so Flat Fee never approves again on its own
    record(t, `Execution Market could not tell whether the escrow was released (${op.state}); waiting for the task's status`);
  }

  // ------------------------------------------------------------------------------------------------- the end
  /**
   * The escrow paid the worker. Keep the answer for the buyer and send the worker the $WIF once, but only for a
   * delivery Flat Fee accepted, or (when EM released it on its own) one that passes the same review Flat Fee applies.
   */
  async function finish(t: Task, remote: EmTask, approved: { submissionId: string; answer: string | null } | null, paymentTx: string | null) {
    if (t.status === "done") return;
    const e = t.em!;
    let sid = approved?.submissionId ?? null;
    let answer = approved?.answer ?? null;
    let reviewed = approved !== null;
    if (sid === null || answer === null) {
      const subs = await api.submissions(e.taskId!);
      const paid = (sid ? subs.find((s) => String(s.id).toLowerCase() === sid) : null) ?? subs.find((s) => s?.status === "accepted") ?? null;
      if (paid) {
        sid = String(paid.id).toLowerCase();
        if (!reviewed) {
          // released by EM, not by Flat Fee: the same review as before an approval, and never a delivery it rejected
          reviewed = e.accepted === sid || (!e.rejected.some((r) => r.submissionId === sid) && manifestProblem(paid) === null);
        }
        answer = answerOf((await api.openEvidence(emId(paid.id, "submission id"))).evidence);
      }
    }
    const s = signedFor(t, remote.executor_id ?? e.executorId);
    const worker = s?.wallet ?? null;
    // done first, then the reward: a stop in between sends nothing rather than twice
    save(t, { step: "completed", approval: null, paymentTx: paymentTx ?? e.paymentTx, lastError: null }, { status: "done", answer, worker, doneAt: now().toISOString() });
    log(`hire ${t.id}: completed on Execution Market, the escrow paid ${worker ?? "the worker"}`);
    if (cfg.wif.workerReward <= 0n) return;
    const refuse = (why: string) => {
      store.updateTask(t.id, { rewardError: why });
      log(`hire ${t.id}: no $WIF reward: ${why}`);
    };
    if (!worker) return refuse("Execution Market paid an executor Flat Fee signed no escrow for");
    if (!reviewed || answer === null) return refuse("Execution Market released a delivery Flat Fee did not accept");
    try {
      const r = await sendWif(worker, cfg.wif.workerReward);
      store.updateTask(t.id, { rewardTx: r.tx });
      log(`reward ${formatUnits(cfg.wif.workerReward, WIF_DECIMALS)} $WIF -> ${worker}: ${r.tx}`);
    } catch (err) {
      store.updateTask(t.id, { rewardTx: err instanceof WifTransferUnconfirmed ? err.tx : null, rewardError: redact(err) });
      log(`reward to ${worker} failed: ${redact(err)}`);
    }
  }

  // ------------------------------------------------------------------------------------------------- the loop
  async function advance(t: Task) {
    const e = t.em!;
    if (e.step === "publishing") return publishNow(t);
    if (!e.taskId) return end(t, "failed", "no task id on Execution Market");
    const remote = await api.getTask(e.taskId);
    save(t, { status: remote.status, deadline: typeof remote.deadline === "string" ? remote.deadline : e.deadline, escrowTx: txHash(remote.escrow_tx) ?? e.escrowTx });
    // read from the task's escrow row as it is now; the task's own refund_tx is not enough, since a withdraw that
    // re-opens the task for another worker may leave the earlier refund there while the new escrow is live
    const refunded = REFUNDED.has(String(remote.escrow_status ?? ""));
    switch (remote.status) {
      case "published":
        return onPublished(t, remote);
      case "assigning":
        return save(t, { step: "assigning" });
      case "accepted":
      case "in_progress":
        return refunded ? onRefunded(t) : onAssigned(t, remote);
      case "submitted":
      case "verifying":
        return refunded ? onRefunded(t) : onSubmitted(t, remote);
      case "completed":
        return finish(t, remote, null, txHash(remote.payment_tx));
      case "expired":
      case "cancelled":
        return end(t, "expired", `the task was ${remote.status} on Execution Market`);
      default:
        // disputed, or a status this server does not know yet: EM decides, Flat Fee waits
        return;
    }
  }

  const step = async (id: string) => {
    const t = store.task(id);
    if (!t?.em || TERMINAL.has(t.em.step)) return;
    try {
      await advance(t);
    } catch (e) {
      record(store.task(id)!, e);
    }
  };

  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await refresh();
      const open = store.tasks().filter((t) => t.via === "em" && t.em && !TERMINAL.has(t.em.step)).map((t) => t.id);
      for (const id of open) await serial(id, () => step(id));
    } finally {
      ticking = false;
    }
  };

  return {
    unavailable,
    refuses,
    refresh,
    publish: (taskId) => serial(taskId, () => step(taskId)),
    tick,
    start() {
      const timer = setInterval(() => void tick(), em.pollSeconds * 1000);
      timer.unref?.();
      void tick();
      return () => clearInterval(timer);
    },
  };
}
