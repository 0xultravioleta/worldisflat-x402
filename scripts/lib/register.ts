// `npm run em:register`, kept apart from the network so it can be tested (test/register.test.ts): the merchant wallet's
// ERC-8004 identity on Base, which Execution Market requires of every publisher (EM_REQUIRE_ERC8004; without it a
// publish answers 403 identity_required, after the buyer paid). Read from EM's routes (UltravioletaDAO/execution-market
// 647b419e, mcp_server/api/reputation.py): `GET /api/v1/reputation/register/wallet/{wallet}?network=base` (public:
// registered, pending or none), `POST /api/v1/reputation/register` signed by the wallet itself (gasless: EM's
// facilitator mints), and `GET /api/v1/reputation/register/{id}` until it completes. It registers at most once: EM warns
// that a second registration can mint a duplicate identity.
import { getAddress, isAddress } from "ethers";

export interface RegisterPlan {
  merchant: string;
  agentUri: string;
  /** CONFIRM_EM_REGISTER: the merchant's address, typed by the operator; anything else is a dry run */
  confirm: string | null;
  pollMs: number;
  timeoutMs: number;
}

export interface RegisterDeps {
  /** a public GET of Execution Market, by path */
  get(path: string): Promise<{ status: number; body: any }>;
  /** the registration, signed with ERC-8128 by the merchant wallet */
  register(body: { network: "base"; agent_uri: string }): Promise<{ status: number; body: any }>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface RegisterOutcome {
  ok: boolean;
  /** what the run found or ended with: registered, completed, dry-run, failed, timeout, refused */
  status: string;
  agentId: string | null;
  transaction: string | null;
  message: string;
  /** registrations sent: 0 or 1, never more */
  sent: number;
}

const POLL = /^\/api\/v1\/reputation\/register\/[A-Za-z0-9-]{1,64}$/;
const str = (v: unknown) => (typeof v === "string" && v ? v : v === 0 || typeof v === "number" ? String(v) : null);

/** why the plan cannot run, or null; the agent_uri must be an https URL of 1-2048 characters (EM's limit) */
export function registerPlanRefusal(p: { merchant: string; agentUri: string }): string | null {
  if (!isAddress(p.merchant)) return "the merchant is not an address";
  let u: URL;
  try {
    u = new URL(p.agentUri);
  } catch {
    return "EM_AGENT_URI is not a URL";
  }
  if (u.protocol !== "https:" || p.agentUri.length > 2048) return "EM_AGENT_URI must be an https URL of at most 2048 characters";
  return null;
}

export async function runRegister(plan: RegisterPlan, d: RegisterDeps): Promise<RegisterOutcome> {
  const merchant = getAddress(plan.merchant.toLowerCase());
  let sent = 0;
  const done = (ok: boolean, status: string, message: string, agentId: unknown = null, transaction: unknown = null): RegisterOutcome => {
    d.log(message);
    return { ok, status, agentId: str(agentId), transaction: str(transaction), message, sent };
  };

  // follows a registration in flight until EM says it completed or failed; never registers again
  const follow = async (poll: unknown): Promise<RegisterOutcome> => {
    if (typeof poll !== "string" || !POLL.test(poll)) return done(false, "refused", "Execution Market gave no registration of its own to follow; do NOT register again: read the status first");
    const deadline = d.now() + plan.timeoutMs;
    for (;;) {
      let r: { status: number; body: any } | null = null;
      try {
        r = await d.get(poll);
      } catch (e) {
        d.log(`${poll}: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      }
      const s = r?.body?.status;
      if (s) d.log(`${poll}: ${s}`);
      if (s === "completed") return done(true, "completed", `ERC-8004 identity on Base registered for ${merchant}: agent ${str(r!.body.agent_id) ?? "(id not given)"}`, r!.body.agent_id, r!.body.transaction);
      if (s === "failed") return done(false, "failed", `Execution Market's registration failed (${String(r!.body.error ?? "no reason given").slice(0, 200)}); do NOT register again before reading ${poll}`);
      if (d.now() >= deadline) return done(false, "timeout", `the registration is still ${s ?? "unknown"} after ${Math.round(plan.timeoutMs / 60_000)} min; do NOT register again: run this again later, it follows the same registration`);
      await d.sleep(plan.pollMs);
    }
  };

  // 1. what EM knows of this wallet on Base: an identity, one in flight, or none
  let r: { status: number; body: any };
  try {
    r = await d.get(`/api/v1/reputation/register/wallet/${merchant}?network=base`);
  } catch (e) {
    return done(false, "refused", `cannot read the merchant's identity status on Execution Market (${String((e as Error)?.message ?? e).slice(0, 160)}): nothing sent`);
  }
  const status = r.body?.status;
  d.log(`Execution Market, ${merchant} on base: ${String(status)}${r.body?.agent_id != null ? ` (agent ${str(r.body.agent_id)})` : ""}`);
  if (status === "registered") return done(true, "registered", `${merchant} already has an ERC-8004 identity on Base (agent ${str(r.body.agent_id) ?? "?"}): nothing to do`, r.body.agent_id);
  if (status === "pending") return follow(r.body.poll);
  if (status !== "none") return done(false, "refused", `unexpected identity status ${String(status).slice(0, 40)} from Execution Market: nothing sent`);

  // 2. none: register once, and only with the operator's confirmation
  if (!plan.confirm || !isAddress(plan.confirm.trim()) || getAddress(plan.confirm.trim().toLowerCase()) !== merchant) {
    return done(false, "dry-run", `dry run: ${merchant} has no ERC-8004 identity on Base. This would POST /api/v1/reputation/register {network: "base", agent_uri: "${plan.agentUri}"}, signed by that wallet (gasless). Re-run with CONFIRM_EM_REGISTER=${merchant} to send it, once.`);
  }
  sent++;
  let reg: { status: number; body: any };
  try {
    reg = await d.register({ network: "base", agent_uri: plan.agentUri });
  } catch (e) {
    const m = String((e as Error)?.message ?? e).slice(0, 200);
    const s = (e as { status?: unknown } | null)?.status;
    // no answer in time: EM may have taken it (it waits a while before answering 202)
    if (s === 0 || (typeof s === "number" && s >= 500)) {
      return done(false, "unknown", `Execution Market did not answer the registration (${m}): it may have gone through. Do NOT send it again by hand: run this again, it reads the status first and follows a registration in flight`);
    }
    return done(false, "failed", `Execution Market did not take the registration (${m}); do NOT register again before reading /api/v1/reputation/register/wallet/${merchant}?network=base`);
  }
  if (reg.status === 202 || reg.body?.registration_id) return follow(reg.body?.poll ?? (reg.body?.registration_id ? `/api/v1/reputation/register/${reg.body.registration_id}` : null));
  if (reg.body?.success === true) return done(true, "completed", `ERC-8004 identity on Base registered for ${merchant}: agent ${str(reg.body.agent_id) ?? "(id not given)"}`, reg.body.agent_id, reg.body.transaction);
  return done(false, "failed", `Execution Market answered the registration without success (${String(reg.body?.error ?? reg.body?.message ?? "no reason").slice(0, 200)}); do NOT register again before reading the status`);
}
