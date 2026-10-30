// The rules of a live run (`npm run e2e:testnet` / `e2e:mainnet`), kept apart from the network so they can be tested.
import { WIF_DECIMALS, formatUnits, type Config } from "../../src/config.js";
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
