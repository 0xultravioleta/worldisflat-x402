// Hire a human through Execution Market (EM_HIRE=on). Flat Fee acts as an agent there: it publishes the task the buyer
// paid for, assigns the first eligible applicant while the merchant pays the bounty into a USDG escrow, reviews the
// delivery, approves it (the escrow pays the worker) or rejects it with the reason, then sends the worker the $WIF
// reward and keeps the answer for the buyer. A loop drives every open hire from its status on Execution Market, so a
// step that failed (EM unreachable, a timeout) is simply tried again on the next pass.
import { getAddress, isAddress } from "ethers";
import { WifTransferUnconfirmed } from "./chain.js";
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, type Config, type EmConfig } from "./config.js";
import { EmHttpError, emId, txHash, type EmApi, type EmApplication, type EmSubmission, type EmTask } from "./em.js";
import type { EmTaskState, Store, Task } from "./store.js";
import type { SendWif } from "./wif.js";

/** the longest text answer Flat Fee accepts from a worker (EM measures the delivery in bytes) */
export const MAX_ANSWER_BYTES = 2000;

const TERMINAL = new Set<EmTaskState["step"]>(["completed", "expired", "failed"]);

export interface EmHireDeps {
  cfg: Config & { em: EmConfig };
  store: Store;
  api: EmApi;
  sendWif: SendWif;
  /** the merchant wallet's address: never assigned as a worker */
  merchant: string;
  /** the escrow authorization (X-Payment-Auth) for `worker`, from EM's published escrow parameters (src/escrow.ts) */
  paymentAuth: (paymentConfig: unknown, worker: string, deadlineSec: number) => Promise<string>;
  /** why EM's published escrow parameters cannot carry a hire now, or null (src/escrow.ts escrowReadiness) */
  ready: (paymentConfig: unknown) => string | null;
  /** the merchant wallet's USDG, which pays every escrow */
  usdgBalance: () => Promise<bigint>;
  log?: (msg: string) => void;
  now?: () => Date;
  /** how an error is written into the task and the log (no URLs, no keys) */
  redact?: (e: unknown) => string;
}

export interface EmHire {
  /** why a new hire is refused before its 402 (Execution Market cannot take it, or the merchant cannot fund it); null when it can run */
  unavailable(): string | null;
  /** checks it again: EM's escrow for this network and the merchant's USDG (each pass does) */
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
    taskId: null,
    status: null,
    deadline: null,
    executorId: null,
    workerWallet: null,
    escrowTx: null,
    skipped: [],
    rejected: [],
    approval: null,
    paymentTx: null,
    lastError: null,
    updatedAt: at.toISOString(),
  };
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** why the delivery cannot be accepted, read from EM's manifest (what it holds, never what it says); null when it can */
export function manifestProblem(s: EmSubmission): string | null {
  const items = s.evidence_manifest?.items;
  if (!Array.isArray(items)) return null; // no manifest: the text itself is checked once opened
  const text = items.find((i) => i?.field === "text_response");
  if (!text) return "No text_response in the delivery: write the answer as text (text_response).";
  if (typeof text.size_bytes === "number" && text.size_bytes <= 0) return "The text_response is empty: write the answer as text.";
  if (typeof text.size_bytes === "number" && text.size_bytes > MAX_ANSWER_BYTES) return `The text_response is longer than ${MAX_ANSWER_BYTES} bytes: keep the answer short.`;
  return null;
}

/** the worker's text answer out of the opened evidence, trimmed; null when there is none */
export function answerOf(evidence: unknown): string | null {
  const v = (evidence as Record<string, unknown> | null)?.text_response;
  const raw =
    typeof v === "string"
      ? v
      : v && typeof v === "object"
        ? [(v as Record<string, unknown>).value, (v as Record<string, unknown>).text, (v as Record<string, unknown>).content].find((x): x is string => typeof x === "string")
        : undefined;
  const t = raw?.trim();
  return t ? t.slice(0, MAX_ANSWER_BYTES) : null;
}

export function createEmHire({
  cfg,
  store,
  api,
  sendWif,
  merchant,
  paymentAuth,
  ready,
  usdgBalance,
  log = console.log,
  now = () => new Date(),
  redact = (e) => (e as Error)?.message ?? String(e),
}: EmHireDeps): EmHire {
  const em = cfg.em;

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
    const msg = redact(e);
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

  async function publishNow(t: Task) {
    if (late(t)) return end(t, "failed", "could not publish on Execution Market before the deadline");
    const oneLine = t.request.replace(/\s+/g, " ").trim();
    const reward = cfg.wif.workerReward > 0n ? ` Flat Fee then sends you ${formatUnits(cfg.wif.workerReward, WIF_DECIMALS)} $WIF on ${cfg.chain.label} on top of the bounty.` : "";
    const body: Record<string, unknown> = {
      title: `Flat Fee: ${oneLine.slice(0, 80)}`,
      instructions: `${t.request}\n\nDeliver your answer as text (text_response), at most ${MAX_ANSWER_BYTES} bytes. Flat Fee reviews it and approves it, which releases the escrowed bounty to you.${reward}`,
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
      // the key is the task's own: a publish sent again (a timeout, a restart) never makes a second task on EM
      const r = await api.createTask(body, `flatfee-${t.id}`);
      save(t, { step: "published", taskId: r.id, status: r.status ?? null, deadline: typeof r.deadline === "string" ? r.deadline : null, lastError: null });
      log(`hire ${t.id} published on Execution Market as ${r.id}`);
    } catch (e) {
      if (e instanceof EmHttpError && !e.retryable) return end(t, "failed", `Execution Market refused the task: ${redact(e)}`);
      record(t, e);
    }
  }

  /** the applicant to assign: EM's ranking first, never one EM flagged, never the buyer, the merchant or one that failed */
  function choose(t: Task, apps: EmApplication[]): { executorId: string; wallet: string } | null {
    const eligible = apps.filter((a) => {
      if (a?.status !== "pending" || typeof a.executor_id !== "string") return false;
      if (typeof a.wallet_address !== "string" || !isAddress(a.wallet_address)) return false;
      if (sameAddress(a.wallet_address, t.payer) || sameAddress(a.wallet_address, merchant)) return false;
      if (a.review || a.recommended === false) return false;
      return !t.em!.skipped.includes(a.executor_id.toLowerCase());
    });
    eligible.sort(
      (a, b) =>
        (b.effective_reputation_score ?? 0) - (a.effective_reputation_score ?? 0) ||
        (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0),
    );
    for (const a of eligible) {
      try {
        return { executorId: emId(a.executor_id, "executor id"), wallet: getAddress(a.wallet_address!.toLowerCase()) };
      } catch {
        // not a UUID: never put into a path
      }
    }
    return null;
  }

  async function onPublished(t: Task, remote: EmTask) {
    const e = t.em!;
    if (e.step === "assigning" && e.executorId) {
      // EM put the task back: the escrow lock did not land. That applicant is not tried again.
      const f = remote.escrow_lock_failure;
      const why = String(f?.reason ?? f?.code ?? "the escrow lock did not land").slice(0, 200);
      save(t, { step: "published", skipped: [...e.skipped, e.executorId], executorId: null, workerWallet: null, lastError: `escrow lock failed: ${why}` });
      log(`hire ${t.id}: escrow lock failed (${why}); the next applicant gets it`);
    } else if (e.step !== "published") {
      save(t, { step: "published" }, { status: "open", worker: null });
    }
    if (late(t)) {
      await api.cancel(e.taskId!, "Nobody was assigned before the deadline.");
      return end(t, "expired", "nobody took the task before its deadline; cancelled on Execution Market, nothing was locked");
    }
    const pick = choose(t, await api.applications(e.taskId!));
    if (!pick) return;
    const auth = await paymentAuth(await api.paymentConfig(), pick.wallet, Math.floor(deadlineOf(t) / 1000));
    // written down before EM is asked, so the next pass knows whom this pass assigned whatever happens to the call
    save(t, { step: "assigning", executorId: pick.executorId, workerWallet: pick.wallet, lastError: null });
    let r: { status: number; workerWallet: string | null };
    try {
      r = await api.assign(e.taskId!, pick.executorId, auth);
    } catch (err) {
      // a 409 means EM's state moved under us: stay "assigning" and read it on the next pass
      if (!(err instanceof EmHttpError && err.status === 409)) {
        const refused = err instanceof EmHttpError && !err.retryable;
        save(t, { step: "published", executorId: null, workerWallet: null, ...(refused ? { skipped: [...t.em!.skipped, pick.executorId] } : {}) });
      }
      throw err;
    }
    if (r.workerWallet && !sameAddress(r.workerWallet, pick.wallet)) {
      log(`hire ${t.id}: Execution Market names ${r.workerWallet} as the worker's wallet; the escrow and the $WIF go to ${pick.wallet}`);
    }
    if (r.status === 202) return log(`hire ${t.id}: assigned on Execution Market, escrow lock in flight`);
    save(t, { step: "assigned" }, { status: "claimed", worker: pick.wallet });
    log(`hire ${t.id}: assigned to ${pick.wallet}, ${formatUnits(em.bounty, USDG_DECIMALS)} USDG in escrow`);
  }

  async function onSubmitted(t: Task) {
    const e = t.em!;
    if (e.approval) return followApproval(t);
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
    // what the manifest already shows is rejected without opening the delivery
    const problem = manifestProblem(s);
    if (problem) return reject(problem);
    const answer = answerOf((await api.openEvidence(sid)).evidence);
    if (!answer) return reject("No readable text answer in the delivery: write the answer as text (text_response).");
    const approval = await api.approve(sid, "Accepted by Flat Fee.");
    if (approval.status === 202) {
      save(t, { step: "approving", approval: { submissionId: sid, poll: approval.poll! }, lastError: null });
      return log(`hire ${t.id}: approval queued on Execution Market`);
    }
    return finish(t, answer, approval.paymentTx);
  }

  async function followApproval(t: Task) {
    const op = await api.operation(t.em!.approval!.poll);
    if (!op.done) return;
    if (op.state === "succeeded") return finish(t, null, txHash(op.response?.data?.payment_tx));
    if (op.state === "failed") {
      // EM refused and the escrow still holds the bounty: the delivery is reviewed and approved again
      return save(t, { step: "assigned", approval: null, lastError: "Execution Market could not release the escrow; approving again" });
    }
    // unresolved: EM cannot tell what happened to the escrow, so Flat Fee never approves again on its own
    save(t, { lastError: `Execution Market could not tell whether the escrow was released (${op.state}); waiting for the task's status` });
  }

  /** the worker was paid by the escrow: keep the answer for the buyer, then send the worker the $WIF, once */
  async function finish(t: Task, answer: string | null, paymentTx: string | null) {
    if (t.status === "done") return;
    let text = answer;
    if (text === null) {
      const accepted = (await api.submissions(t.em!.taskId!)).find((s) => s?.status === "accepted");
      if (accepted) text = answerOf((await api.openEvidence(emId(accepted.id, "submission id"))).evidence);
    }
    const worker = t.em!.workerWallet;
    // done first, then the reward: a stop in between sends nothing rather than twice
    save(
      t,
      { step: "completed", approval: null, paymentTx: paymentTx ?? t.em!.paymentTx, lastError: null },
      { status: "done", answer: text, worker, doneAt: now().toISOString() },
    );
    log(`hire ${t.id}: approved on Execution Market, the escrow paid ${worker}`);
    if (cfg.wif.workerReward <= 0n) return;
    if (!worker) {
      store.updateTask(t.id, { rewardError: "no worker wallet known for this task" });
      return;
    }
    try {
      const r = await sendWif(worker, cfg.wif.workerReward);
      store.updateTask(t.id, { rewardTx: r.tx });
      log(`reward ${formatUnits(cfg.wif.workerReward, WIF_DECIMALS)} $WIF -> ${worker}: ${r.tx}`);
    } catch (e) {
      store.updateTask(t.id, { rewardTx: e instanceof WifTransferUnconfirmed ? e.tx : null, rewardError: redact(e) });
      log(`reward to ${worker} failed: ${redact(e)}`);
    }
  }

  async function advance(t: Task) {
    const e = t.em!;
    if (e.step === "publishing") return publishNow(t);
    if (!e.taskId) return end(t, "failed", "no task id on Execution Market");
    const remote = await api.getTask(e.taskId);
    save(t, { status: remote.status, deadline: typeof remote.deadline === "string" ? remote.deadline : e.deadline, escrowTx: txHash(remote.escrow_tx) ?? e.escrowTx });
    switch (remote.status) {
      case "published":
        return onPublished(t, remote);
      case "assigning":
        return save(t, { step: "assigning" });
      case "accepted":
      case "in_progress":
        if (e.step !== "assigned" && e.step !== "approving") save(t, { step: "assigned", lastError: null }, { status: "claimed", worker: e.workerWallet });
        return;
      case "submitted":
      case "verifying":
        return onSubmitted(t);
      case "completed":
        return finish(t, null, txHash(remote.payment_tx));
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

  // until a first check answers, nobody pays for a hire; an unreachable EM or RPC later keeps the last answer, since
  // a hire paid then is published by the loop once EM answers again
  let unavailable: string | null = "Execution Market has not been checked yet";
  const refresh = async () => {
    let why: string | null;
    try {
      why = ready(await api.paymentConfig());
      if (!why && (await usdgBalance()) < em.bounty) why = `the merchant wallet holds less than one bounty (${formatUnits(em.bounty, USDG_DECIMALS)} USDG) for the escrow`;
    } catch (e) {
      log(`Execution Market check failed: ${redact(e)}`);
      return;
    }
    if (why !== unavailable) log(why ? `hiring paused: ${why}` : "hiring through Execution Market is open");
    unavailable = why;
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
    unavailable: () => unavailable,
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
