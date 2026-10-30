// Reads and writes on Robinhood Chain: token balances, the $WIF holder tier, and the $WIF transfers (cashback, worker reward).
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";
import type { Config } from "./config.js";
import { waitForReceipt } from "./receipt.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export type Tier = "standard" | "holder";

export interface WifTransfer {
  to: string;
  amount: bigint;
  tx: string;
}

/**
 * A $WIF transfer that was broadcast but not seen mined in time. It may still land, so its $WIF counts as sent: the
 * daily budget keeps it and the ledger keeps its hash.
 */
export class WifTransferUnconfirmed extends Error {
  constructor(readonly tx: string, cause: unknown) {
    super(`$WIF transfer ${tx} not confirmed yet: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export interface Chain {
  provider: JsonRpcProvider;
  balanceOf(token: string, owner: string): Promise<bigint>;
  /** "holder" when `owner` holds at least WIF_HOLDER_MIN $WIF; "standard" if there is no $WIF token or the read fails */
  tierOf(owner: string): Promise<Tier>;
  /** sends $WIF from the merchant wallet; resolves once the transfer is mined, rejects with WifTransferUnconfirmed when it was broadcast but not seen mined */
  sendWif(to: string, amount: bigint): Promise<WifTransfer>;
  merchantAddress: string | null;
}

export function connectChain(cfg: Config): Chain {
  // no request cache: two $WIF transfers in a row must each read a fresh nonce
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chain.chainId, { staticNetwork: true, cacheTimeout: -1 });
  let merchant: Wallet | null = null;
  if (cfg.merchantKey) {
    try {
      merchant = new Wallet(cfg.merchantKey, provider);
    } catch {
      // ethers' error carries the whole key; loadConfig checks it first, this covers a Config built by hand
      throw new Error("MERCHANT_PRIVATE_KEY is not a valid private key; the value is not shown");
    }
  }
  const wifToken = cfg.wif.token;
  // one writer at a time, so two paid calls never race for the same merchant nonce
  let queue: Promise<unknown> = Promise.resolve();

  const balanceOf = async (token: string, owner: string): Promise<bigint> => {
    const c = new Contract(token, ERC20_ABI, provider);
    return (await c.balanceOf(getAddress(owner))) as bigint;
  };

  return {
    provider,
    balanceOf,
    merchantAddress: merchant?.address ?? null,
    async tierOf(owner) {
      if (!wifToken) return "standard";
      try {
        return (await balanceOf(wifToken, owner)) >= cfg.wif.holderMin ? "holder" : "standard";
      } catch {
        // the price can only go down for holders, so a failed read charges the standard price, never less
        return "standard";
      }
    },
    sendWif(to, amount) {
      if (!merchant || !wifToken) return Promise.reject(new Error("no merchant wallet or $WIF token configured"));
      if (amount <= 0n) return Promise.reject(new Error("a $WIF transfer needs an amount above zero"));
      const run = async (): Promise<WifTransfer> => {
        const c = new Contract(wifToken, ERC20_ABI, merchant);
        const tx = await c.transfer(getAddress(to), amount);
        let receipt;
        try {
          receipt = await waitForReceipt(provider, tx.hash);
        } catch (e) {
          throw new WifTransferUnconfirmed(tx.hash, e);
        }
        if (receipt.status !== 1) throw new Error(`$WIF transfer ${tx.hash} reverted`);
        return { to: getAddress(to), amount, tx: tx.hash as string };
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
