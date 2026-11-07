// The worker's side of Execution Market, for `npm run e2e:hire`: apply to the task Flat Fee published, then deliver a
// text answer once the escrow locked. Read from EM's routes (UltravioletaDAO/execution-market 647b419e,
// mcp_server/api/routers/workers.py): `POST /api/v1/tasks/{id}/apply` (body optional; the applying wallet's executor
// profile is made on the fly) and `POST /api/v1/tasks/{id}/submit` with `{evidence: {text_response}}`.
//
// A worker proves who it is with an ERC-8128 signature of its own wallet, or with the session of EM's dashboard
// (a bearer token). `client` is the client value the operator approved for the test worker, sent with each signed
// request (X-EM-Client).
import type { BaseWallet } from "ethers";
import { signRequestWithSigner } from "uvd-x402-sdk/erc8128";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type WorkerAuth = { kind: "erc8128"; wallet: BaseWallet; chainId: number; client: string | null } | { kind: "token"; token: string; address: string };

export interface EmWorker {
  /** the worker's payout wallet: the escrow's receiver and the $WIF reward's recipient */
  address: string;
  apply(taskId: string): Promise<{ status: number; body: unknown }>;
  submit(taskId: string, text: string): Promise<{ status: number; body: unknown }>;
  /** the task as Execution Market shows it to a participant (an applicant or the assigned executor: tasks.py get_task) */
  task(taskId: string): Promise<unknown>;
}

/** an answer from Execution Market other than success; the message carries no header, token or signature */
export class EmWorkerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function taskPath(taskId: string, action: "apply" | "submit" | null): string {
  if (!UUID.test(taskId)) throw new EmWorkerError(0, "bad_id", "the Execution Market task id is not a UUID");
  return `/api/v1/tasks/${taskId.toLowerCase()}${action ? `/${action}` : ""}`;
}

function refusal(status: number, body: unknown): EmWorkerError {
  const b = (body ?? {}) as Record<string, unknown>;
  const d = typeof b.detail === "object" && b.detail !== null ? (b.detail as Record<string, unknown>) : {};
  const code = [d.error, d.code, b.error, b.code].find((x): x is string => typeof x === "string") ?? null;
  const message = [typeof b.detail === "string" ? b.detail : undefined, d.message, b.message].find((x): x is string => typeof x === "string");
  return new EmWorkerError(status, code, `Execution Market answered ${status}${code ? ` ${code}` : ""}${message ? `: ${message.slice(0, 200)}` : ""}`);
}

export interface EmCallerOptions {
  apiUrl: string;
  auth: WorkerAuth;
  fetch?: Fetch;
  timeoutMs?: number;
}

/** one request to Execution Market as `auth` (an ERC-8128 signature over a fresh nonce, or a bearer session); throws EmWorkerError on anything but 2xx */
export function emCaller({ apiUrl, auth, fetch: fetchFn = globalThis.fetch, timeoutMs = 20_000 }: EmCallerOptions) {
  const send = async (url: string, init: RequestInit) => {
    let r: Response;
    try {
      r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new EmWorkerError(0, "unreachable", `Execution Market did not answer within ${timeoutMs} ms`);
    }
    const raw = await r.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!r.ok) throw refusal(r.status, body);
    return { status: r.status, body };
  };

  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const url = `${apiUrl}${path}`;
    const text = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (text !== null) headers["content-type"] = "application/json";
    if (auth.kind === "token") {
      headers.authorization = `Bearer ${auth.token}`;
    } else {
      const { body: n } = await send(`${apiUrl}/api/v1/auth/erc8128/nonce`, { method: "GET", headers: { accept: "application/json" } });
      const nonce = (n as { nonce?: unknown } | null)?.nonce;
      if (typeof nonce !== "string" || !nonce) throw new EmWorkerError(0, "no_nonce", "Execution Market sent no ERC-8128 nonce");
      const wallet = auth.wallet;
      const signature = await signRequestWithSigner({ address: wallet.address, signMessage: (m: string) => wallet.signMessage(m), method, url, nonce, body: text, chainId: auth.chainId });
      Object.assign(headers, signature as unknown as Record<string, string>);
      if (auth.client) headers["x-em-client"] = auth.client;
    }
    return send(url, { method, headers, ...(text !== null ? { body: text } : {}) });
  };
  return { call, send };
}

export function emWorker(opts: EmCallerOptions): EmWorker {
  const { auth } = opts;
  const { call } = emCaller(opts);
  return {
    address: auth.kind === "token" ? auth.address : auth.wallet.address,
    // no message: EM screens applicants' messages, and the task needs none
    apply: (taskId) => call("POST", taskPath(taskId, "apply"), {}),
    submit: (taskId, text) => call("POST", taskPath(taskId, "submit"), { evidence: { text_response: text } }),
    task: async (taskId) => (await call("GET", taskPath(taskId, null))).body,
  };
}
