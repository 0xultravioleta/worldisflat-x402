// Execution Market's REST API, as Flat Fee uses it when it hires a human there: publish a task, read its applicants,
// assign one with an escrow authorization, read the delivery, approve or reject it. Every request is signed with
// ERC-8128 (RFC 9421) by the merchant wallet, EM's only agent auth in production, with a fresh nonce from EM.
import type { BaseWallet } from "ethers";
import { signRequestWithSigner } from "uvd-x402-sdk/erc8128";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An answer from Execution Market other than success, or no answer at all (status 0: unreachable or timed out). */
export class EmHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /** what EM itself says about retrying (`retryable` in its body), when it says it */
    readonly serverRetryable: boolean | null = null,
    /** a settlement operation EM points to (`detail.poll`), only ever one of its own paths */
    readonly poll: string | null = null,
    /** the fields a validation 422 names (`errors[].field`, or FastAPI's `detail[].loc`); "(unknown)" for one it does not */
    readonly fields: string[] = [],
  ) {
    super(message);
  }

  /** the request did not get a verdict: EM was unreachable, busy, or the publisher's identity is still being made */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500 || this.code?.toLowerCase() === "identity_registering";
  }

  /** worth sending again later, unchanged: a transient failure, or a refusal EM itself marks `retryable: true` */
  get retryable(): boolean {
    return this.transient || this.serverRetryable === true;
  }
}

export interface EmTask {
  id: string;
  status: string;
  deadline?: string | null;
  escrow_tx?: string | null;
  payment_tx?: string | null;
  executor_id?: string | null;
  escrow_lock_failure?: { code?: string | null; reason?: string | null; retryable?: boolean | null; at?: string | null } | null;
  /** the status of the task's escrow row (pending_assignment, locked, released, refunding, refunded...) */
  escrow_status?: string | null;
}

export interface EmApplication {
  id: string;
  executor_id: string;
  status: string;
  created_at?: string;
  wallet_address?: string | null;
  effective_reputation_score?: number | null;
  recommended?: boolean | null;
  review?: { level?: string } | null;
  /** the party the applicant applied as: human, agent, human_via_agent, robot */
  executor_type?: string | null;
  executor_kind?: string | null;
}

export interface EmSubmission {
  id: string;
  task_id: string;
  executor_id: string;
  /** pending, accepted, rejected, more_info_requested, disputed */
  status: string;
  agent_verdict?: string | null;
  submitted_at?: string;
  evidence_manifest?: { items?: { field?: string | null; type?: string; size_bytes?: number }[] } | null;
}

export interface EmApproval {
  /** 200: paid now; 202: EM queued the release, follow `poll` */
  status: 200 | 202;
  paymentTx: string | null;
  poll: string | null;
}

export interface EmOperation {
  done: boolean;
  /** queued, running, succeeded, failed, unresolved */
  state: string;
  response?: { data?: { payment_tx?: string | null } } & Record<string, unknown> | null;
}

export interface EmApi {
  createTask(body: Record<string, unknown>, idempotencyKey: string): Promise<EmTask>;
  getTask(id: string): Promise<EmTask>;
  applications(taskId: string): Promise<EmApplication[]>;
  paymentConfig(): Promise<unknown>;
  /** assigns `executorId` and hands EM the escrow authorization (X-Payment-Auth); 202 means the lock is in flight */
  assign(taskId: string, executorId: string, paymentAuth: string): Promise<{ status: number; workerWallet: string | null }>;
  submissions(taskId: string): Promise<EmSubmission[]>;
  /** hands over what the worker delivered; EM records that the publisher has read it */
  openEvidence(submissionId: string): Promise<{ evidence: unknown; notes: string | null }>;
  /** approves, with the payer-signed release order when there is one (EM requires it where its facilitator does) */
  approve(submissionId: string, notes: string, lifecycleOrder?: Record<string, unknown> | null): Promise<EmApproval>;
  reject(submissionId: string, notes: string): Promise<void>;
  cancel(taskId: string, reason: string): Promise<void>;
  /** a queued approval, by the poll path EM gave */
  operation(poll: string): Promise<EmOperation>;
}

export interface EmClientOptions {
  apiUrl: string;
  /** the merchant wallet: Flat Fee's identity on Execution Market */
  wallet: BaseWallet;
  /** the chain id named in the ERC-8128 keyid */
  chainId: number;
  fetch?: Fetch;
  /** per request, nonce included */
  timeoutMs?: number;
}

// EM's ids are UUIDs; nothing else is ever put into a path
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL = /^\/api\/v1\/settlement-operations\/[0-9a-f-]{36}$/i;
const TX = /^0x[0-9a-fA-F]{64}$/;

export function emId(id: unknown, what = "id"): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new EmHttpError(0, "bad_id", `Execution Market sent a ${what} that is not a UUID`);
  return id.toLowerCase();
}

export const txHash = (v: unknown): string | null => (typeof v === "string" && TX.test(v) ? v : null);

function errorOf(status: number, body: unknown): EmHttpError {
  const b = (body ?? {}) as Record<string, unknown>;
  const detail = b.detail as Record<string, unknown> | string | undefined;
  const d = typeof detail === "object" && detail !== null ? detail : {};
  const code = [d.code, d.error, b.code, b.error].find((x): x is string => typeof x === "string") ?? null;
  const message = [typeof detail === "string" ? detail : undefined, d.message, b.message].find((x): x is string => typeof x === "string");
  const serverRetryable = [d.retryable, b.retryable].find((x): x is boolean => typeof x === "boolean") ?? null;
  const poll = [d.poll, b.poll].find((x): x is string => typeof x === "string" && POLL.test(x)) ?? null;
  // EM's own 422 handler lists `errors: [{field}]`; FastAPI's default lists `detail: [{loc: ["body", field]}]`
  const fields: string[] = [];
  const named = (x: unknown) => (typeof x === "string" && x ? x : "(unknown)");
  if (Array.isArray(b.errors)) for (const e of b.errors) fields.push(named((e as Record<string, unknown> | null)?.field));
  if (Array.isArray(detail)) {
    for (const e of detail as unknown[]) {
      const loc = (e as { loc?: unknown } | null)?.loc;
      fields.push(named(Array.isArray(loc) ? loc.filter((p) => p !== "body").join(".") : null));
    }
  }
  return new EmHttpError(status, code, `Execution Market answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message.slice(0, 200)}` : ""}`, serverRetryable, poll, fields);
}

export function emClient({ apiUrl, wallet, chainId, fetch: fetchFn = globalThis.fetch, timeoutMs = 15_000 }: EmClientOptions): EmApi {
  const send = async (url: string, init: RequestInit): Promise<{ status: number; body: unknown }> => {
    let r: Response;
    try {
      r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      throw new EmHttpError(0, timedOut ? "timeout" : "unreachable", timedOut ? `Execution Market did not answer within ${timeoutMs} ms` : "Execution Market is unreachable");
    }
    const raw = await r.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!r.ok) throw errorOf(r.status, body);
    return { status: r.status, body };
  };

  const nonce = async (): Promise<string> => {
    const { body } = await send(`${apiUrl}/api/v1/auth/erc8128/nonce`, { method: "GET", headers: { accept: "application/json" } });
    const n = (body as { nonce?: unknown } | null)?.nonce;
    if (typeof n !== "string" || !n) throw new EmHttpError(0, "no_nonce", "Execution Market sent no ERC-8128 nonce");
    return n;
  };

  /** one signed request: a fresh nonce, then the request signed over its method, authority, path, query and body */
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const url = `${apiUrl}${path}`;
    const text = body === undefined ? null : JSON.stringify(body);
    const signature = await signRequestWithSigner({
      address: wallet.address,
      signMessage: (base: string) => wallet.signMessage(base),
      method,
      url,
      nonce: await nonce(),
      body: text,
      chainId,
    });
    const headers: Record<string, string> = { accept: "application/json", ...extra, ...(signature as unknown as Record<string, string>) };
    if (text !== null) headers["content-type"] = "application/json";
    return send(url, { method, headers, ...(text !== null ? { body: text } : {}) });
  };

  const list = <T>(body: unknown, key: string): T[] => {
    const v = (body as Record<string, unknown> | null)?.[key];
    return Array.isArray(v) ? (v as T[]) : [];
  };

  return {
    async createTask(body, idempotencyKey) {
      const { body: t } = await call("POST", "/api/v1/tasks", body, { "Idempotency-Key": idempotencyKey });
      const task = t as EmTask;
      return { ...task, id: emId(task?.id, "task id") };
    },
    async getTask(id) {
      const { body } = await call("GET", `/api/v1/tasks/${emId(id)}`);
      const task = body as EmTask;
      return { ...task, id: emId(task?.id, "task id") };
    },
    async applications(taskId) {
      const { body } = await call("GET", `/api/v1/tasks/${emId(taskId)}/applications`);
      return list<EmApplication>(body, "applications");
    },
    async paymentConfig() {
      return (await call("GET", "/api/v1/h2a/payment-config")).body;
    },
    async assign(taskId, executorId, paymentAuth) {
      const { status, body } = await call(
        "POST",
        `/api/v1/tasks/${emId(taskId)}/assign`,
        { executor_id: emId(executorId, "executor id") },
        { "X-Payment-Auth": paymentAuth },
      );
      const data = ((body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
      return { status, workerWallet: typeof data.worker_wallet === "string" ? data.worker_wallet : null };
    },
    async submissions(taskId) {
      const { body } = await call("GET", `/api/v1/tasks/${emId(taskId)}/submissions`);
      return list<EmSubmission>(body, "submissions");
    },
    async openEvidence(submissionId) {
      const { body } = await call("POST", `/api/v1/submissions/${emId(submissionId)}/evidence/open`);
      const b = (body ?? {}) as { evidence?: unknown; notes?: unknown };
      return { evidence: b.evidence ?? null, notes: typeof b.notes === "string" ? b.notes : null };
    },
    async approve(submissionId, notes, lifecycleOrder) {
      const { status, body } = await call("POST", `/api/v1/submissions/${emId(submissionId)}/approve`, { notes, ...(lifecycleOrder ? { lifecycle_order: lifecycleOrder } : {}) });
      const b = (body ?? {}) as { poll?: unknown; data?: { payment_tx?: unknown } };
      if (status === 202) {
        if (typeof b.poll !== "string" || !POLL.test(b.poll)) throw new EmHttpError(0, "bad_poll", "Execution Market queued the approval without a settlement operation to follow");
        return { status: 202, paymentTx: null, poll: b.poll };
      }
      return { status: 200, paymentTx: txHash(b.data?.payment_tx), poll: null };
    },
    async reject(submissionId, notes) {
      await call("POST", `/api/v1/submissions/${emId(submissionId)}/reject`, { notes, severity: "minor" });
    },
    async cancel(taskId, reason) {
      await call("POST", `/api/v1/tasks/${emId(taskId)}/cancel`, { reason });
    },
    async operation(poll) {
      if (!POLL.test(poll)) throw new EmHttpError(0, "bad_poll", "not a settlement operation of Execution Market");
      const { body } = await call("GET", poll);
      const b = (body ?? {}) as EmOperation;
      return { done: b.done === true, state: typeof b.state === "string" ? b.state : "unknown", response: b.response ?? null };
    },
  };
}
