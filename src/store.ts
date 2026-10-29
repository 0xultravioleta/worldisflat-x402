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
}

export interface Task {
  id: string;
  createdAt: string;
  status: "open" | "claimed" | "done";
  request: string;
  payer: string;
  paidTx: string | null;
  worker: string | null;
  answer: string | null;
  doneAt: string | null;
  rewardTx: string | null;
  rewardError?: string;
}

interface State {
  ledger: LedgerEntry[];
  tasks: Task[];
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
    return { ledger: s.ledger, tasks: s.tasks };
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

  ledger(limit = 50): LedgerEntry[] {
    return this.state.ledger.slice(0, limit);
  }

  createTask(t: Pick<Task, "request" | "payer" | "paidTx">): Task {
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
