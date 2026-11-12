// What the landing page shows as proof (GET /api/proof), and where every figure comes from. Two sources, each
// transaction counted once by its hash:
//   1. the reads on Robinhood Chain kept in docs/evidence/: every USDG and $WIF transfer of the merchant wallet up to a
//      dated block, and the hires and swarm tasks on Execution Market with their escrow and payment transactions;
//   2. what this server settled since it started: its ledger and its tasks (on Lightsail they start empty at each deploy).
// Nothing is estimated or typed by hand: a source that cannot be read is left out and the page says so.
import { readFileSync } from "node:fs";
import { formatUnits, parseUnits } from "ethers";
import { USDG_DECIMALS, WIF_DECIMALS, txUrl, type Config } from "./config.js";
import type { LedgerEntry, Task } from "./store.js";

/** the evidence files the server reads, relative to its working directory (the Dockerfile copies docs/evidence) */
export const EVIDENCE_FILES = ["docs/evidence/robinhood-2026-11-12.json", "docs/evidence/robinhood-swarm-2026-11-12.json"];

interface EvTransfer {
  token: string;
  from: string;
  to: string;
  amount: string;
}
interface EvTx {
  tx: string;
  at: string;
  transfers?: EvTransfer[];
}
interface EvTask {
  id?: string | null;
  bounty_usd?: number;
  agent_id: string;
  erc8004_agent_id?: string;
  status?: string;
  escrow_status?: string;
  title?: string | null;
  escrow_tx?: EvTx | null;
  payment_tx?: EvTx | null;
}

/** what the evidence files hold, as the proof needs it */
export interface Evidence {
  readAt: string;
  block: number;
  merchant: string;
  facilitator: string;
  transfers: (EvTransfer & { tx: string; at: string; sender: string })[];
  tasks: EvTask[];
  /** task id -> the swarm agent that delivered it, from KarmaKadabra's public graph */
  swarmWorkers: Record<string, string>;
  /** wallet (lower case) -> the swarm agent's name, as Execution Market's public API gives it */
  swarmAgents: Record<string, string>;
  /** the merchant's ERC-8004 agent ids, as Execution Market's register records gave them */
  merchantAgents: { robinhood: string | null; base: string | null };
}

/** " (Robinhood Chain)" or " (Base)": which chain's ERC-8004 registry an agent id of the merchant belongs to */
function idChain(ev: Evidence, id: string | undefined): string {
  if (id && id === ev.merchantAgents.robinhood) return " (Robinhood Chain)";
  if (id && id === ev.merchantAgents.base) return " (Base)";
  return "";
}

const lower = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : "");

/**
 * Reads the evidence files. The first one (the merchant's transfers) is required: without it there is no dated read
 * and null is returned. A later file only adds tasks and names; one that cannot be read is skipped.
 */
export function loadEvidence(files: string[] = EVIDENCE_FILES, read: (f: string) => string = (f) => readFileSync(f, "utf8")): Evidence | null {
  let ev: Evidence | null = null;
  for (const [i, file] of files.entries()) {
    let d: any;
    try {
      d = JSON.parse(read(file));
    } catch {
      if (i === 0) return null;
      continue;
    }
    if (i === 0) {
      const mt = d?.merchant_transfers;
      if (!Array.isArray(mt?.items) || typeof d.merchant !== "string" || typeof d.facilitator !== "string" || typeof d.read_at !== "string") return null;
      const workers: Record<string, string> = {};
      for (const t of d.karmakadabra_graph?.tasks ?? []) if (typeof t?.task === "string" && typeof t?.worker === "string") workers[t.task] = t.worker;
      const reg = d.execution_market?.merchant_registrations ?? {};
      const agentId = (n: unknown) => (n != null && /^\d+$/.test(String(n)) ? String(n) : null);
      ev = {
        readAt: d.read_at,
        block: Number(mt.to_block),
        merchant: d.merchant,
        facilitator: d.facilitator,
        transfers: mt.items,
        tasks: [],
        swarmWorkers: workers,
        swarmAgents: {},
        merchantAgents: { robinhood: agentId(reg.robinhood?.agent_id), base: agentId(reg.base?.agent_id) },
      };
    }
    if (!ev) return null;
    for (const [w, name] of Object.entries(d?.swarm_agents ?? {})) if (typeof name === "string") ev.swarmAgents[w.toLowerCase()] = name;
    // a task counts once its payment out of the escrow is recorded: the page lists work paid out of escrow
    for (const t of d?.execution_market?.tasks ?? []) {
      if (typeof t?.agent_id === "string" && typeof t?.payment_tx?.tx === "string") ev.tasks.push(t);
    }
  }
  return ev;
}

export interface ProofTx {
  tx: string;
  url: string;
  at: string;
  amount: string;
  /** "chain": in the dated reads of docs/evidence; "server": settled by this server since it started */
  source: "chain" | "server";
  kind?: "cashback" | "reward";
}

export interface ProofCounter {
  count: number;
  /** the sum, as a decimal string in the token's units */
  amount: string;
  txs: ProofTx[];
}

export interface WorkCard {
  kind: "flatfee" | "swarm";
  /** who hired, and who was paid, in words the evidence supports */
  from: string;
  to: string;
  title: string | null;
  /** short id shown on the card, e.g. "3175424d" */
  ref: string;
  status: string;
  bounty: string | null;
  /** USDG the escrow paid to whoever delivered */
  paid: string | null;
  at: string;
  escrowTx: string | null;
  escrowUrl: string | null;
  paymentTx: string | null;
  paymentUrl: string | null;
  /** the task's page on Execution Market, when its full id is known */
  page: string | null;
}

export interface Proof {
  /** the dated on-chain read, or null when it is missing or belongs to another merchant or network */
  snapshot: { readAt: string; block: number } | null;
  /** when this server started counting its own settlements */
  serverSince: string;
  merchantUrl: string;
  paidCalls: ProofCounter;
  wif: ProofCounter & { cashback: { count: number; amount: string }; rewards: { count: number; amount: string } };
  /** Flat Fee's hires whose worker pay it locked in Execution Market's escrow */
  escrows: ProofCounter;
  /** tasks of the KarmaKadabra swarm on the same market, paid out of escrow (Flat Fee is not a party) */
  swarmPaid: number;
  work: WorkCard[];
}

const sum = (txs: ProofTx[], decimals: number) => formatUnits(txs.reduce((a, t) => a + parseUnits(t.amount, decimals), 0n), decimals);
const counter = (txs: ProofTx[], decimals: number): ProofCounter => ({ count: txs.length, amount: sum(txs, decimals), txs });
const hashOk = (h: unknown): h is string => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const byNewest = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

export const TEST_WORKER_LABEL = "Flat Fee's test worker (a team wallet run by a script)";

/**
 * The proof the page shows. The dated read counts only when this server is that merchant on Robinhood Chain mainnet;
 * a server on another wallet or on testnet shows its own settlements only.
 */
export function buildProof(
  cfg: Config,
  evidence: Evidence | null,
  ledger: LedgerEntry[],
  tasks: Task[],
  serverSince: string,
  opts: { localFork?: boolean } = {},
): Proof {
  const chain = cfg.chain;
  const ev = evidence && chain.name === "robinhood" && lower(evidence.merchant) === lower(cfg.payTo) ? evidence : null;
  const merchant = lower(cfg.payTo);
  const seen = new Set<string>();
  const add = (list: ProofTx[], t: Omit<ProofTx, "url">) => {
    const key = lower(t.tx);
    if (!hashOk(t.tx) || seen.has(key)) return;
    seen.add(key);
    list.push({ ...t, url: txUrl(chain, t.tx) });
  };

  const paid: ProofTx[] = [];
  const wif: ProofTx[] = [];
  const escrows: ProofTx[] = [];
  const work: WorkCard[] = [];
  let swarm = 0;

  if (ev) {
    // a paid call: USDG into the merchant in a transaction the x402 facilitator submitted (the merchant's own funding is not)
    const settled = ev.transfers.filter((t) => t.token === "USDG" && lower(t.to) === merchant && lower(t.sender) === lower(ev.facilitator));
    for (const t of settled) add(paid, { tx: t.tx, at: t.at, amount: t.amount, source: "chain" });
    const payers = new Set(settled.map((t) => lower(t.from)));
    // $WIF out of the merchant: back to someone who paid a call (cashback), or to a worker (reward)
    for (const t of ev.transfers.filter((t) => t.token === "$WIF" && lower(t.from) === merchant)) {
      add(wif, { tx: t.tx, at: t.at, amount: t.amount, source: "chain", kind: payers.has(lower(t.to)) ? "cashback" : "reward" });
    }
    for (const t of ev.tasks) {
      const mine = lower(t.agent_id) === merchant;
      const lock = (t.escrow_tx?.transfers ?? []).find((x) => lower(x.from) === lower(t.agent_id));
      // a hire paid from escrow: its lock and the payment out of the escrow, both recorded
      if (mine && lock && t.escrow_tx && t.payment_tx?.tx) add(escrows, { tx: t.escrow_tx.tx, at: t.escrow_tx.at, amount: lock.amount, source: "chain" });
      // what the escrow paid whoever delivered: the larger of the payment's transfers (the other one is Execution Market's fee)
      const pay = [...(t.payment_tx?.transfers ?? [])].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
      const buyer = ev.swarmAgents[lower(t.agent_id)];
      const worker = (t.id && ev.swarmWorkers[t.id]) || (pay ? ev.swarmAgents[lower(pay.to)] : undefined);
      if (!mine && t.payment_tx?.tx) swarm++;
      work.push({
        kind: mine ? "flatfee" : "swarm",
        from: mine ? `Flat Fee · ERC-8004 agent ${t.erc8004_agent_id}${idChain(ev, t.erc8004_agent_id)}` : `${buyer ?? "KarmaKadabra agent"} · ERC-8004 agent ${t.erc8004_agent_id}`,
        to: mine ? TEST_WORKER_LABEL : worker ? `${worker} (KarmaKadabra)` : "another KarmaKadabra agent",
        // Execution Market cuts long titles mid-word: Flat Fee's keep the part before the first colon
        title: typeof t.title === "string" ? (mine ? t.title.replace(/^Flat Fee: /, "").split(":")[0] : t.title) : null,
        ref: t.id ? t.id.slice(0, 8) : "",
        status: t.escrow_status === "released" ? "released" : (t.escrow_status ?? t.status ?? "unknown"),
        bounty: lock ? lock.amount : t.bounty_usd != null ? String(t.bounty_usd) : null,
        paid: pay?.amount ?? null,
        at: (t.escrow_tx ?? t.payment_tx)!.at,
        escrowTx: t.escrow_tx?.tx ?? null,
        escrowUrl: t.escrow_tx?.tx ? txUrl(chain, t.escrow_tx.tx) : null,
        paymentTx: t.payment_tx?.tx ?? null,
        paymentUrl: t.payment_tx?.tx ? txUrl(chain, t.payment_tx.tx) : null,
        page: t.id ? `https://execution.market/tasks/${t.id}` : null,
      });
    }
  }

  // this server, since it started: settled calls and the $WIF it sent on this network, and the hires whose escrow paid
  // out. A local fork's settlements are not on the chain the explorer shows: none of them counts.
  for (const e of opts.localFork ? [] : ledger) {
    if (e.network !== chain.caip2) continue;
    if (e.settleTx) add(paid, { tx: e.settleTx, at: e.at, amount: formatUnits(BigInt(e.price), USDG_DECIMALS), source: "server" });
    // a cashback that failed or was not seen mined is not counted
    if (e.cashbackTx && !e.cashbackError && cfg.wif.cashback > 0n) {
      add(wif, { tx: e.cashbackTx, at: e.at, amount: formatUnits(cfg.wif.cashback, WIF_DECIMALS), source: "server", kind: "cashback" });
    }
  }
  const bounty = cfg.em ? formatUnits(cfg.em.bounty, USDG_DECIMALS) : null;
  for (const t of opts.localFork ? [] : tasks) {
    if (t.rewardTx && !t.rewardError && cfg.wif.workerReward > 0n) {
      add(wif, { tx: t.rewardTx, at: t.doneAt ?? t.createdAt, amount: formatUnits(cfg.wif.workerReward, WIF_DECIMALS), source: "server", kind: "reward" });
    }
    const em = t.em;
    // Only a hire whose escrow paid out counts and shows: one still open has nothing locked yet, and one that expired
    // has nothing locked or got its lock back. Neither was "paid from escrow", and no card says it is.
    if (!em?.taskId || !hashOk(em.escrowTx) || !hashOk(em.paymentTx)) continue;
    if (work.some((w) => w.ref === em.taskId!.slice(0, 8))) continue;
    if (bounty) add(escrows, { tx: em.escrowTx, at: em.assignedAt ?? t.createdAt, amount: bounty, source: "server" });
    work.push({
      kind: "flatfee",
      from: "Flat Fee",
      to: "a worker on Execution Market",
      title: t.request,
      ref: em.taskId.slice(0, 8),
      status: "released",
      bounty,
      paid: null,
      at: t.createdAt,
      escrowTx: em.escrowTx,
      escrowUrl: txUrl(chain, em.escrowTx),
      paymentTx: em.paymentTx,
      paymentUrl: txUrl(chain, em.paymentTx),
      page: `https://execution.market/tasks/${em.taskId}`,
    });
  }

  for (const list of [paid, wif, escrows]) list.sort(byNewest);
  work.sort(byNewest);
  const cashback = wif.filter((t) => t.kind === "cashback");
  const rewards = wif.filter((t) => t.kind === "reward");
  return {
    snapshot: ev ? { readAt: ev.readAt, block: ev.block } : null,
    serverSince,
    merchantUrl: `${chain.explorer}/address/${cfg.payTo}`,
    paidCalls: counter(paid, USDG_DECIMALS),
    wif: {
      ...counter(wif, WIF_DECIMALS),
      cashback: { count: cashback.length, amount: sum(cashback, WIF_DECIMALS) },
      rewards: { count: rewards.length, amount: sum(rewards, WIF_DECIMALS) },
    },
    escrows: counter(escrows, USDG_DECIMALS),
    swarmPaid: swarm,
    work: work.slice(0, 12),
  };
}
