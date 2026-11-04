// $WIF out of the merchant wallet, inside the daily budget: the cashback, the board's worker reward and the reward of
// a worker hired through Execution Market all draw from the same budget in state.json.
import { WifTransferUnconfirmed, type Chain, type WifTransfer } from "./chain.js";
import type { Config } from "./config.js";
import type { Store } from "./store.js";

export type SendWif = (to: string, amount: bigint) => Promise<WifTransfer>;

/**
 * $WIF the server may send per UTC day (cashback + worker rewards), kept in state.json so a restart does not refill
 * it. Reserved before each send; given back only when nothing was broadcast, since a transfer with a hash may still be
 * mined. Whatever $WIF is worth tomorrow, a loop of paid calls cannot drain the merchant faster than this.
 */
export function budgetedWif(cfg: Config, chain: Chain, store: Store, now: () => Date = () => new Date()): SendWif {
  return async (to, amount) => {
    const day = now().toISOString().slice(0, 10);
    if (!store.reserveWif(day, amount, cfg.wif.dailyBudget)) throw new Error("daily $WIF budget used up (WIF_DAILY_BUDGET)");
    try {
      return await chain.sendWif(to, amount);
    } catch (e) {
      if (!(e instanceof WifTransferUnconfirmed)) store.releaseWif(day, amount);
      throw e;
    }
  };
}
