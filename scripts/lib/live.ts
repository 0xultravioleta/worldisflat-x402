// The rules of a live run (`npm run e2e:testnet` / `e2e:mainnet`), kept apart from the network so they can be tested.
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, type Config } from "../../src/config.js";
import { confirms } from "./buyer.js";

type Env = Record<string, string | undefined>;

/**
 * Why a live run must stop before it reads the chain or signs anything, or null when it may go ahead. On mainnet the
 * run exists to produce the two transactions the contest asks for, so it refuses to settle USDG without also sending
 * the approved $WIF cashback: both amounts must be approved and match the configuration exactly.
 */
export function liveRunRefusal(cfg: Config, env: Env): string | null {
  if (cfg.chain.name !== "robinhood") return null;
  if (!env.CONFIRM_MAINNET_SPEND?.trim()) return "mainnet: set CONFIRM_MAINNET_SPEND to the approved USDG amount (e.g. 0.10)";
  if (cfg.wif.cashback <= 0n) {
    return "mainnet: this run must also send the $WIF cashback: set WIF_CASHBACK=10 and MERCHANT_PRIVATE_KEY in .env";
  }
  const wif = formatUnits(cfg.wif.cashback, WIF_DECIMALS);
  if (!confirms(env.CONFIRM_MAINNET_WIF, cfg.wif.cashback, WIF_DECIMALS)) {
    return `mainnet: this run sends ${wif} $WIF cashback; re-run with CONFIRM_MAINNET_WIF=${wif} once that amount is approved`;
  }
  return null;
}

export interface LiveOutcome {
  status: number;
  /** USDG left the payer and reached PAY_TO, exactly the price */
  usdgMoved: boolean;
  /** atomic $WIF the run was set to send back (0 when cashback is off) */
  cashback: bigint;
  cashbackTx: string | null | undefined;
  /** atomic $WIF the payer gained during the run */
  wifGained: bigint;
}

/** a run passes when the call was served, the USDG moved, and the configured cashback landed in full */
export function livePassed(o: LiveOutcome): boolean {
  if (o.status !== 200 || !o.usdgMoved) return false;
  if (o.cashback === 0n) return true;
  return typeof o.cashbackTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(o.cashbackTx) && o.wifGained === o.cashback;
}

/**
 * Why a live run must not pay a server that is already running (FLATFEE_URL), or null when that server's `/api/info`
 * says it is set up as this run expects: not a local fork, and the same network, recipient, USDG, $WIF token, holder
 * minimum, ask prices (the run asks one question) and cashback. Such a server sends the cashback with its own merchant
 * key; the run checks on chain that it landed.
 */
export function remoteRefusal(cfg: Config, info: any): string | null {
  if (info?.localFork !== false) return "FLATFEE_URL: its /api/info does not say localFork: false, so it is not a live server: refusing";
  const norm = (x: unknown) => (typeof x === "string" ? x.toLowerCase() : (x ?? null));
  const want: [string, unknown, string | null][] = [
    ["network", info.network?.caip2, cfg.chain.caip2],
    ["pay-to", info.payTo, cfg.payTo],
    ["USDG", info.usdg, cfg.chain.usdg],
    ["$WIF token", info.wif?.token, cfg.wif.token],
    ["$WIF holder minimum", info.wif?.holderMin, formatUnits(cfg.wif.holderMin, WIF_DECIMALS)],
    ["$WIF cashback", info.wif?.cashback, formatUnits(cfg.wif.cashback, WIF_DECIMALS)],
    ["ask price", info.prices?.ask?.standard, formatUnits(cfg.prices.ask, USDG_DECIMALS)],
    ["holder ask price", info.prices?.ask?.holder, formatUnits(cfg.prices.askHolder, USDG_DECIMALS)],
  ];
  for (const [what, got, expected] of want) {
    if (norm(got) !== norm(expected)) return `FLATFEE_URL serves ${what} ${String(got).slice(0, 80)}, this run expects ${expected}: refusing`;
  }
  return null;
}

/**
 * The cashback a server recorded for a settlement, read from its `/api/ledger`: null while it is still pending (or the
 * entry is not there yet), else the transfer's hash and the error it recorded, either of which may be null.
 */
export function ledgerCashback(ledger: unknown, settleTx: string): { tx: string | null; error: string | null } | null {
  if (!Array.isArray(ledger)) return null;
  const e = ledger.find((x) => typeof x?.settleTx === "string" && x.settleTx.toLowerCase() === settleTx.toLowerCase());
  const tx = typeof e?.cashbackTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(e.cashbackTx) ? e.cashbackTx : null;
  const error = typeof e?.cashbackError === "string" ? e.cashbackError : null;
  return tx || error ? { tx, error } : null;
}
