// Everything the app knows about Robinhood Chain, USDG, $WIF and prices, read from the environment once.
import { SigningKey, getAddress, isAddress } from "ethers";

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
    /** $WIF (atomic) the server may send per UTC day, cashback and rewards together */
    dailyBudget: bigint;
  };
  /** signs the $WIF transfers; only needed when cashback or workerReward is on */
  merchantKey: string | null;
  /** shared secret the human worker console sends as X-Worker-Token; required when workerReward is on (board mode) */
  workerToken: string | null;
  /** hire a human through Execution Market (EM_HIRE=on); null keeps the task board */
  em: EmConfig | null;
  port: number;
  publicUrl: string | null;
  dataDir: string;
}

/** Flat Fee as an agent on Execution Market: where it publishes, what it locks in escrow, and which contracts it trusts. */
export interface EmConfig {
  /** Execution Market's API origin, e.g. https://api.execution.market */
  apiUrl: string;
  /** atomic USDG the merchant locks in escrow per task: the worker's bounty */
  bounty: bigint;
  deadlineHours: number;
  pollSeconds: number;
  /** the token EM records for the task (USDG on Robinhood Chain) */
  paymentToken: string;
  /** the escrow contracts on this network, as deployed for EM; an escrow is only signed when EM publishes the same ones */
  escrow: { escrow: string; operator: string; tokenCollector: string };
  /** optional `reputation_network` for the tasks Flat Fee publishes; null lets EM decide */
  reputationNetwork: string | null;
}

/** the on-chain deposit limit of the x402r escrow, per deposit */
export const EM_DEPOSIT_LIMIT_USDG = 100;

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v ? v : null;
}

function address(env: Env, key: string, fallback: string | null = null): string | null {
  const v = str(env, key) ?? fallback;
  if (v === null) return null;
  // the value is not repeated: a private key pasted into the wrong variable would be printed whole
  if (!isAddress(v)) throw new ConfigError(`${key} is not an address (0x and 40 hex digits); the value is not shown`);
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

/**
 * A private key from the environment: 64 hex digits, with or without 0x, inside the secp256k1 range. Returned with 0x.
 * The error names the variable and never the value: ethers' own error would print the whole key, and a key one digit
 * short is a few hundred guesses away from the real one.
 */
export function privateKey(env: Env, key: string): string | null {
  const v = str(env, key);
  if (v === null) return null;
  const k = /^[0-9a-fA-F]{64}$/.test(v) ? `0x${v}` : v;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new ConfigError(`${key} is not a private key (0x and 64 hex digits); the value is not shown`);
  try {
    // throws for 0 and for anything at or above the curve order
    void new SigningKey(k).publicKey;
  } catch {
    throw new ConfigError(`${key} is outside the secp256k1 range; the value is not shown`);
  }
  return k;
}

function amount(env: Env, key: string, fallback: string, decimals: number): bigint {
  return parseUnitsStrict(str(env, key) ?? fallback, decimals, key);
}

/** on/off switches: on, true, 1, yes / off, false, 0, no (any case); unset is off; anything else is refused */
export function onOff(env: Env, key: string): boolean {
  const v = (str(env, key) ?? "off").toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  throw new ConfigError(`${key} must be on or off`);
}

function integer(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key) ?? String(fallback);
  const n = /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= min && n <= max)) throw new ConfigError(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * An API origin: https (http only for localhost), no credentials, no path, query or fragment. The value is not repeated
 * in the error, since a URL can carry a key.
 */
export function apiOrigin(env: Env, key: string): string | null {
  const v = str(env, key);
  if (v === null) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${key} is not a URL; the value is not shown`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new ConfigError(`${key} must start with https:// (http:// only for localhost)`);
  if (u.username || u.password) throw new ConfigError(`${key} must not carry credentials; the value is not shown`);
  if (u.pathname !== "/" || u.search || u.hash) throw new ConfigError(`${key} must be an origin only, like https://api.execution.market`);
  return u.origin;
}

function contract(env: Env, key: string): string {
  const a = address(env, key);
  if (!a) throw new ConfigError(`EM_HIRE=on needs ${key}: the escrow contracts on this network, as deployed for Execution Market`);
  if (BigInt(a) === 0n) throw new ConfigError(`${key} cannot be the zero address`);
  return a;
}

function loadEm(env: Env, prices: Config["prices"], merchantKey: string | null): EmConfig | null {
  if (!onOff(env, "EM_HIRE")) return null;
  const apiUrl = apiOrigin(env, "EM_API_URL");
  if (!apiUrl) throw new ConfigError("EM_HIRE=on needs EM_API_URL (Execution Market's API origin)");
  // the merchant wallet is Flat Fee's identity on Execution Market and the payer of every escrow
  if (!merchantKey) throw new ConfigError("EM_HIRE=on needs MERCHANT_PRIVATE_KEY: it signs for Flat Fee on Execution Market and pays the escrow");
  const bounty = amount(env, "EM_BOUNTY_USDG", "0.20", USDG_DECIMALS);
  if (bounty <= 0n) throw new ConfigError("EM_BOUNTY_USDG must be above zero");
  // each escrow is covered by the hire that bought it, whatever tier paid for it
  if (bounty > prices.hireHolder) throw new ConfigError("EM_BOUNTY_USDG cannot be above PRICE_HIRE_HOLDER_USDG");
  if (bounty > BigInt(EM_DEPOSIT_LIMIT_USDG) * 10n ** BigInt(USDG_DECIMALS)) {
    throw new ConfigError(`EM_BOUNTY_USDG cannot be above the escrow's deposit limit (${EM_DEPOSIT_LIMIT_USDG} USDG)`);
  }
  const paymentToken = str(env, "EM_PAYMENT_TOKEN") ?? "USDG";
  if (!/^[A-Za-z0-9]{1,16}$/.test(paymentToken)) throw new ConfigError("EM_PAYMENT_TOKEN must be a token symbol, like USDG");
  const reputationNetwork = str(env, "EM_REPUTATION_NETWORK")?.toLowerCase() ?? null;
  if (reputationNetwork !== null && !/^[a-z0-9-]{1,30}$/.test(reputationNetwork)) {
    throw new ConfigError("EM_REPUTATION_NETWORK must be a network name, like robinhood");
  }
  const escrow = {
    escrow: contract(env, "EM_ESCROW_ADDRESS"),
    operator: contract(env, "EM_OPERATOR_ADDRESS"),
    tokenCollector: contract(env, "EM_TOKEN_COLLECTOR_ADDRESS"),
  };
  return {
    apiUrl,
    bounty,
    deadlineHours: integer(env, "EM_DEADLINE_HOURS", 24, 1, 720),
    pollSeconds: integer(env, "EM_POLL_SECONDS", 30, 5, 3600),
    paymentToken,
    escrow,
    reputationNetwork,
  };
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
    dailyBudget: amount(env, "WIF_DAILY_BUDGET", "500", WIF_DECIMALS),
  };
  // 0 would make every payer a holder
  if (wif.holderMin <= 0n) throw new ConfigError("WIF_HOLDER_MIN must be above zero");
  const merchantKey = privateKey(env, "MERCHANT_PRIVATE_KEY");
  if ((wif.cashback > 0n || wif.workerReward > 0n) && (!merchantKey || !wif.token)) {
    throw new ConfigError("WIF_CASHBACK / WIF_WORKER_REWARD need MERCHANT_PRIVATE_KEY and a $WIF token");
  }
  // a budget below one transfer would turn every cashback or reward into a refusal
  for (const [name, v] of [["WIF_CASHBACK", wif.cashback], ["WIF_WORKER_REWARD", wif.workerReward]] as const) {
    if (v > wif.dailyBudget) throw new ConfigError(`WIF_DAILY_BUDGET is below one ${name}`);
  }
  const workerToken = str(env, "WORKER_TOKEN");
  const em = loadEm(env, prices, merchantKey);
  // on the board, the token is what keeps strangers from completing tasks; through Execution Market, Flat Fee itself
  // approves the delivery before any $WIF goes out
  if (wif.workerReward > 0n && !workerToken && !em) {
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
    em,
    port,
    publicUrl: str(env, "PUBLIC_URL")?.replace(/\/+$/, "") ?? null,
    dataDir: str(env, "DATA_DIR") ?? "data",
  };
}

export const txUrl = (chain: ChainInfo, hash: string) => `${chain.explorer}/tx/${hash}`;
export const addressUrl = (chain: ChainInfo, addr: string) => `${chain.explorer}/address/${addr}`;
