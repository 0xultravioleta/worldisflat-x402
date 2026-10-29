// Everything the app knows about Robinhood Chain, USDG, $WIF and prices, read from the environment once.
import { getAddress, isAddress } from "ethers";

export type NetworkName = "robinhood" | "robinhood-testnet";

export interface ChainInfo {
  name: NetworkName;
  label: string;
  chainId: number;
  caip2: string;
  rpcUrl: string;
  explorer: string;
  usdg: string;
  /** $WIF only exists on mainnet; on testnet it is optional (WIF_ADDRESS) */
  wif: string | null;
}

// Facts checked against the chain and the facilitator's /supported on 2026-10-29.
export const CHAINS: Record<NetworkName, ChainInfo> = {
  robinhood: {
    name: "robinhood",
    label: "Robinhood Chain",
    chainId: 4663,
    caip2: "eip155:4663",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    wif: "0x5173b8ea6923c2d40267890d45c46a3480954773",
  },
  "robinhood-testnet": {
    name: "robinhood-testnet",
    label: "Robinhood Chain Testnet",
    chainId: 46630,
    caip2: "eip155:46630",
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    usdg: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
    wif: null,
  },
};

/** USDG's EIP-712 domain. Its on-chain version() reverts, so it has to travel in the 402's `extra`. */
export const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;
export const USDG_DECIMALS = 6;
export const WIF_DECIMALS = 18;
export const DEFAULT_FACILITATOR_URL = "https://facilitator.ultravioletadao.xyz";

export interface Config {
  chain: ChainInfo;
  rpcUrl: string;
  facilitatorUrl: string;
  payTo: string;
  /** atomic USDG (6 decimals) */
  prices: { ask: bigint; askHolder: bigint; hire: bigint; hireHolder: bigint };
  wif: {
    token: string | null;
    /** $WIF (atomic, 18 decimals) a payer must hold to get the holder price */
    holderMin: bigint;
    /** $WIF (atomic) sent back to the payer after each settled call; 0 turns it off */
    cashback: bigint;
    /** $WIF (atomic) sent to the human who completes a hire task; 0 turns it off */
    workerReward: bigint;
  };
  /** signs the $WIF transfers; only needed when cashback or workerReward is on */
  merchantKey: string | null;
  /** shared secret the human worker console sends as X-Worker-Token; required when workerReward is on */
  workerToken: string | null;
  port: number;
  publicUrl: string | null;
  dataDir: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function address(env: Env, key: string, fallback: string | null = null): string | null {
  const v = str(env, key) ?? fallback;
  if (v === null) return null;
  if (!isAddress(v)) throw new ConfigError(`${key} is not an address: ${v}`);
  return getAddress(v.toLowerCase());
}

/** "0.10" -> 100000n at 6 decimals. Strict: digits, an optional dot, at most `decimals` places, never negative. */
export function parseUnitsStrict(value: string, decimals: number, key = "amount"): bigint {
  const v = value.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) throw new ConfigError(`${key} must be a plain decimal number, got "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new ConfigError(`${key} has more than ${decimals} decimals: "${value}"`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

function amount(env: Env, key: string, fallback: string, decimals: number): bigint {
  return parseUnitsStrict(str(env, key) ?? fallback, decimals, key);
}

export function loadConfig(env: Env = process.env): Config {
  const networkName = (str(env, "NETWORK") ?? "robinhood-testnet").toLowerCase();
  if (networkName !== "robinhood" && networkName !== "robinhood-testnet") {
    throw new ConfigError(`NETWORK must be robinhood or robinhood-testnet, got "${networkName}"`);
  }
  const chain = CHAINS[networkName];
  const payTo = address(env, "PAY_TO");
  if (!payTo) throw new ConfigError("PAY_TO (the wallet that receives USDG) is required");

  const prices = {
    ask: amount(env, "PRICE_ASK_USDG", "0.10", USDG_DECIMALS),
    askHolder: amount(env, "PRICE_ASK_HOLDER_USDG", "0.05", USDG_DECIMALS),
    hire: amount(env, "PRICE_HIRE_USDG", "0.50", USDG_DECIMALS),
    hireHolder: amount(env, "PRICE_HIRE_HOLDER_USDG", "0.25", USDG_DECIMALS),
  };
  for (const [k, v] of Object.entries(prices)) {
    if (v <= 0n) throw new ConfigError(`price ${k} must be above zero`);
  }
  if (prices.askHolder > prices.ask || prices.hireHolder > prices.hire) {
    throw new ConfigError("a holder price cannot be above the standard price");
  }

  const wif = {
    token: address(env, "WIF_ADDRESS", chain.wif),
    holderMin: amount(env, "WIF_HOLDER_MIN", "100", WIF_DECIMALS),
    cashback: amount(env, "WIF_CASHBACK", "0", WIF_DECIMALS),
    workerReward: amount(env, "WIF_WORKER_REWARD", "0", WIF_DECIMALS),
  };
  const merchantKey = str(env, "MERCHANT_PRIVATE_KEY");
  if ((wif.cashback > 0n || wif.workerReward > 0n) && (!merchantKey || !wif.token)) {
    throw new ConfigError("WIF_CASHBACK / WIF_WORKER_REWARD need MERCHANT_PRIVATE_KEY and a $WIF token");
  }
  const workerToken = str(env, "WORKER_TOKEN");
  if (wif.workerReward > 0n && !workerToken) {
    throw new ConfigError("WIF_WORKER_REWARD needs WORKER_TOKEN, or anyone could complete tasks and collect $WIF");
  }

  const port = Number(str(env, "PORT") ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`PORT is not a port: ${env.PORT}`);

  return {
    chain,
    rpcUrl: str(env, "RPC_URL") ?? chain.rpcUrl,
    facilitatorUrl: (str(env, "FACILITATOR_URL") ?? DEFAULT_FACILITATOR_URL).replace(/\/+$/, ""),
    payTo,
    prices,
    wif,
    merchantKey,
    workerToken,
    port,
    publicUrl: str(env, "PUBLIC_URL")?.replace(/\/+$/, "") ?? null,
    dataDir: str(env, "DATA_DIR") ?? "data",
  };
}

export const txUrl = (chain: ChainInfo, hash: string) => `${chain.explorer}/tx/${hash}`;
export const addressUrl = (chain: ChainInfo, addr: string) => `${chain.explorer}/address/${addr}`;
