// The paid-call ledger and the hire-a-human task board, kept in one JSON file under DATA_DIR.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LedgerEntry {
  id: string;
  kind: "ask" | "hire";
  at: string;
  network: string;
  payer: string;
  tier: "standard" | "holder";
  /** atomic USDG */
  price: string;
  settleTx: string | null;
  cashbackTx: string | null;
  /** why the cashback did not go out, when it did not */
  cashbackError?: string;
  question?: string;
  taskId?: string;
  /** `${payer}:${nonce}` of the USDG authorization this call was served for */
  authorization?: string;
}

/** Where a task stands on Execution Market (EM_HIRE=on), as Flat Fee last saw it */
export interface EmTaskState {
  /** Flat Fee's step: publishing → published → assigning → assigned → (approving) → completed, or expired/failed */
  step: "publishing" | "published" | "assigning" | "assigned" | "approving" | "completed" | "expired" | "failed";
  /** the Idempotency-Key of its publish: one task on Execution Market per hire, whatever is retried */
  key: string;
  /** the task's id on Execution Market, once published */
  taskId: string | null;
  /** the task's status on Execution Market, as last read */
  status: string | null;
  deadline: string | null;
  executorId: string | null;
  /** the worker's payout wallet on this network: the escrow's receiver and the $WIF reward's recipient */
  workerWallet: string | null;
  escrowTx: string | null;
  /** executors whose escrow lock failed, never tried again for this task */
  skipped: string[];
  /**
   * every escrow authorization the merchant signed for this task: who it pays, until when it can still be used, the
   * paymentInfo (needed to release it, or to reclaim it) and the signed header itself, sent again rather than re-signed
   */
  signed: { executorId: string; wallet: string; validBefore: number; paymentInfo: Record<string, unknown>; auth: string }[];
  /** the delivery that passed Flat Fee's review and was approved (or is being approved) */
  accepted: string | null;
  /** releases EM refused; capped, so a release that keeps failing waits for a person */
  approvals: number;
  /** EM asked for the payer's release order (LIFECYCLE_ORDER_REQUIRED): every approval of this task carries one */
  needsOrder: boolean;
  /** when the last assignment was sent, to tell a lock failure of that attempt from an older one */
  assignedAt: string | null;
  /** deliveries Flat Fee rejected, with the reason it gave */
  rejected: { submissionId: string; reason: string }[];
  /** an approval EM queued (202): its settlement operation, followed until done */
  approval: { submissionId: string; poll: string } | null;
  paymentTx: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface Task {
  id: string;
  createdAt: string;
  /** board: open → claimed → done; through Execution Market the same, or expired */
  status: "open" | "claimed" | "done" | "expired";
  request: string;
  payer: string;
  paidTx: string | null;
  worker: string | null;
  answer: string | null;
  doneAt: string | null;
  rewardTx: string | null;
  rewardError?: string;
  /** "em" when the task runs on Execution Market instead of the board */
  via?: "em";
  em?: EmTaskState;
}

interface State {
  ledger: LedgerEntry[];
  tasks: Task[];
  /** $WIF (atomic, as a string) reserved for transfers on `day` (UTC, YYYY-MM-DD); kept here so a restart does not refill it */
  wifBudget?: { day: string; spent: string };
  /** hiring through Execution Market paused after EM refused a publish outright, for the EM settings of `config` */
  emPause?: EmPause;
}

export interface EmPause {
  reason: string;
  /** the EM settings in force when it was recorded: other settings lift it */
  config: string;
  at: string;
}

export class Store {
  private state: State;
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    this.state = Store.read(this.file);
  }

  private static read(file: string): State {
    if (!existsSync(file)) return { ledger: [], tasks: [] };
    // a file that is there but unreadable stops the server: starting empty would overwrite the history on the next save
    let s: Partial<State>;
    try {
      s = JSON.parse(readFileSync(file, "utf8")) as Partial<State>;
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${(e as Error).message}); move it away or run npm run reset`);
    }
    if (!Array.isArray(s?.ledger) || !Array.isArray(s?.tasks)) throw new Error(`${file} has no ledger/tasks arrays; move it away or run npm run reset`);
    const b = s.wifBudget;
    if (b !== undefined && (typeof b?.day !== "string" || typeof b?.spent !== "string" || !/^\d+$/.test(b.spent))) {
      throw new Error(`${file} has an unreadable wifBudget; move it away or run npm run reset`);
    }
    const p = s.emPause;
    const pause = p && typeof p.reason === "string" && typeof p.config === "string" && typeof p.at === "string" ? { emPause: p } : {};
    return { ledger: s.ledger, tasks: s.tasks, ...(b ? { wifBudget: b } : {}), ...pause };
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  addLedger(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
    const entry = { id: randomUUID(), at: new Date().toISOString(), ...e };
    this.state.ledger.unshift(entry);
    this.save();
    return entry;
  }

  updateLedger(id: string, patch: Partial<LedgerEntry>) {
    const e = this.state.ledger.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    this.save();
  }

  /** the entry already served for this authorization, if any */
  servedFor(authorization: string): LedgerEntry | undefined {
    return this.state.ledger.find((e) => e.authorization === authorization);
  }

  /** $WIF already reserved on `day` */
  wifSpent(day: string): bigint {
    const b = this.state.wifBudget;
    return b && b.day === day ? BigInt(b.spent) : 0n;
  }

  /** reserves `amount` of `day`'s $WIF budget; false, and nothing reserved, when it would go over `cap` */
  reserveWif(day: string, amount: bigint, cap: bigint): boolean {
    const spent = this.wifSpent(day);
    if (spent + amount > cap) return false;
    this.state.wifBudget = { day, spent: (spent + amount).toString() };
    this.save();
    return true;
  }

  /** gives back a reservation that sent nothing; a reservation from another day has already expired */
  releaseWif(day: string, amount: bigint) {
    const spent = this.wifSpent(day);
    if (!this.state.wifBudget || this.state.wifBudget.day !== day) return;
    this.state.wifBudget = { day, spent: (spent >= amount ? spent - amount : 0n).toString() };
    this.save();
  }

  ledger(limit = 50): LedgerEntry[] {
    return this.state.ledger.slice(0, limit);
  }

  createTask(t: Pick<Task, "request" | "payer" | "paidTx"> & Partial<Pick<Task, "via" | "em">>): Task {
    const task: Task = {
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      status: "open",
      worker: null,
      answer: null,
      doneAt: null,
      rewardTx: null,
      ...t,
    };
    this.state.tasks.unshift(task);
    this.save();
    return task;
  }

  task(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  tasks(): Task[] {
    return this.state.tasks;
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const t = this.task(id);
    if (!t) return undefined;
    Object.assign(t, patch);
    this.save();
    return t;
  }

  emPause(): EmPause | undefined {
    return this.state.emPause;
  }

  setEmPause(pause: EmPause | null) {
    if (pause) this.state.emPause = pause;
    else delete this.state.emPause;
    this.save();
  }

  reset() {
    this.state = { ledger: [], tasks: [] };
    this.save();
  }

  /** empties DATA_DIR/state.json without reading it, so a corrupt file can be cleared too */
  static resetDir(dataDir: string): string {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "state.json");
    writeFileSync(file, JSON.stringify({ ledger: [], tasks: [] }, null, 2));
    return file;
  }
}
