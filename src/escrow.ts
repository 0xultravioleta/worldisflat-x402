// The escrow authorization the merchant signs when Flat Fee assigns a task on Execution Market: an EIP-3009
// ReceiveWithAuthorization of exactly the bounty in USDG to the escrow's token collector, whose nonce commits to the
// chosen worker as receiver. Built by the official builder (uvd-x402-sdk's buildEscrowPreAuth) and checked by Flat Fee
// before it is built (EM's published escrow must be the one Flat Fee is configured for) and after (what was signed is
// exactly that payment). The merchant signs nothing else for Execution Market: no direct payment to a worker, ever.
import { getAddress, isAddress, verifyTypedData, type BaseWallet } from "ethers";
import { ESCROW_CONTRACTS } from "uvd-x402-sdk/backend";
import {
  ESCROW_OPERATORS,
  ESCROW_PAYMENT_INFO_TYPEHASH,
  VERIFIED_USDC_DOMAINS,
  buildEscrowPreAuth,
  computeEscrowNonce,
  type EscrowNetworkConfig,
  type EscrowPaymentInfo,
  type EscrowPreAuthSigner,
} from "uvd-x402-sdk";
import { USDG_DOMAIN, type Config, type EmConfig } from "./config.js";

export type BuildPreAuth = typeof buildEscrowPreAuth;

/** Flat Fee will not sign this escrow; the message says why. */
export class EscrowRefused extends Error {}

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const same = (a: unknown, b: string): boolean => typeof a === "string" && isAddress(a) && getAddress(a.toLowerCase()) === getAddress(b.toLowerCase());

/** the SDK's signer contract, over an ethers wallet: EIP-712 typed data as a JSON string */
export function typedDataSigner(wallet: BaseWallet): EscrowPreAuthSigner {
  return {
    async signTypedData(json: string) {
      const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; message: Record<string, unknown> };
      const { EIP712Domain: _domain, ...types } = td.types ?? {};
      return { signature: await wallet.signTypedData(td.domain, types, td.message) };
    },
  };
}

/**
 * This network's escrow as Execution Market publishes it (GET /api/v1/h2a/payment-config), refused unless its chain,
 * token, escrow, operator and token collector are the ones Flat Fee is configured with. The USDG domain is Flat Fee's
 * own (USDG's on-chain version() reverts, so nobody can read it from the token).
 */
export function escrowNetwork(cfg: Config & { em: EmConfig }, paymentConfig: unknown): EscrowNetworkConfig {
  const escrow = (paymentConfig as { escrow?: Record<string, unknown> } | null)?.escrow;
  const n = (escrow?.networks as Record<string, Record<string, unknown>> | undefined)?.[cfg.chain.name];
  if (!escrow || !n) throw new EscrowRefused(`Execution Market publishes no escrow for ${cfg.chain.name}`);
  if (n.chain_id !== cfg.chain.chainId) throw new EscrowRefused(`Execution Market's ${cfg.chain.name} escrow names another chain`);
  const token = n.usdc ?? (n.tokens as Record<string, { address?: unknown }> | undefined)?.USDG?.address;
  const pinned = [
    ["token", token, cfg.chain.usdg],
    ["escrow", n.escrow, cfg.em.escrow.escrow],
    ["operator", n.operator, cfg.em.escrow.operator],
    ["token collector", n.token_collector, cfg.em.escrow.tokenCollector],
  ] as const;
  for (const [what, theirs, ours] of pinned) {
    if (!same(theirs, ours)) throw new EscrowRefused(`Execution Market's ${what} on ${cfg.chain.name} is not the one Flat Fee is configured with`);
  }
  if (escrow.payment_info_typehash !== ESCROW_PAYMENT_INFO_TYPEHASH) throw new EscrowRefused("Execution Market's escrow typehash is not AuthCaptureEscrow's");
  const micro = (escrow.tier_timings as Record<string, Record<string, unknown>> | undefined)?.micro;
  const tiers =
    micro && [micro.pre, micro.auth, micro.refund].every((v) => Number.isInteger(v))
      ? { micro: { pre: micro.pre as number, auth: micro.auth as number, refund: micro.refund as number } }
      : undefined;
  return {
    chain_id: cfg.chain.chainId,
    operator: cfg.em.escrow.operator,
    escrow: cfg.em.escrow.escrow,
    token_collector: cfg.em.escrow.tokenCollector,
    usdc: cfg.chain.usdg,
    usdc_domain_name: USDG_DOMAIN.name,
    usdc_domain_version: USDG_DOMAIN.version,
    payment_info_typehash: ESCROW_PAYMENT_INFO_TYPEHASH,
    ...(tiers ? { tiers } : {}),
    ...(Number.isInteger(escrow.min_fee_bps) ? { min_fee_bps: escrow.min_fee_bps as number } : {}),
    ...(Number.isInteger(escrow.max_fee_bps) ? { max_fee_bps: escrow.max_fee_bps as number } : {}),
  };
}

/**
 * The X-Payment-Auth the builder returned, refused unless it is an escrow lock of exactly the bounty, from the merchant
 * to the token collector, for this worker, on this network, whose nonce commits to that payment and whose signature
 * is the merchant's over USDG.
 */
export function checkPaymentAuth(cfg: Config & { em: EmConfig }, merchant: string, worker: string, raw: string): void {
  let w: Record<string, any>;
  try {
    w = JSON.parse(raw) as Record<string, any>;
  } catch {
    throw new EscrowRefused("the escrow authorization is not JSON");
  }
  const bounty = cfg.em.bounty.toString();
  const a = w?.payload?.authorization;
  const pi = w?.payload?.paymentInfo as EscrowPaymentInfo | undefined;
  const sig = w?.payload?.signature;
  const fail = (why: string): never => {
    throw new EscrowRefused(`the escrow authorization does not match: ${why}`);
  };
  if (w?.scheme !== "escrow" || w?.paymentRequirements?.scheme !== "escrow") fail("it is not an escrow");
  if (w.paymentRequirements.network !== cfg.chain.caip2) fail("another network");
  if (!a || !pi || typeof sig !== "string") fail("it is incomplete");
  if (!same(a.from, merchant)) fail("another payer");
  if (!same(a.to, cfg.em.escrow.tokenCollector)) fail("another recipient than the token collector");
  if (String(a.value) !== bounty || String(pi!.maxAmount) !== bounty) fail("another amount than the bounty");
  if (!same(pi!.receiver, worker)) fail("another receiver than the worker");
  if (!same(pi!.token, cfg.chain.usdg)) fail("another token than USDG");
  if (!same(pi!.operator, cfg.em.escrow.operator)) fail("another operator");
  let nonce = "";
  try {
    nonce = computeEscrowNonce(cfg.chain.chainId, cfg.em.escrow.escrow, ESCROW_PAYMENT_INFO_TYPEHASH, pi!);
  } catch {
    fail("its payment info cannot be hashed");
  }
  if (typeof a.nonce !== "string" || a.nonce.toLowerCase() !== nonce.toLowerCase()) fail("its nonce does not commit to its payment info");
  let signer = "";
  try {
    const domain = { name: USDG_DOMAIN.name, version: USDG_DOMAIN.version, chainId: cfg.chain.chainId, verifyingContract: cfg.chain.usdg };
    signer = verifyTypedData(domain, RECEIVE_TYPES, a, sig);
  } catch {
    fail("its signature does not verify");
  }
  if (!same(signer, merchant)) fail("it is not signed by the merchant");
}

/** whether uvd-x402-sdk can build an escrow on `chainId`: its builder refuses a chain missing from any of these tables */
export function sdkHasEscrowRow(chainId: number): boolean {
  const row = (t: unknown) => !!(t as Record<number, unknown> | undefined)?.[chainId];
  return row(ESCROW_CONTRACTS) && row(ESCROW_OPERATORS) && row(VERIFIED_USDC_DOMAINS);
}

/**
 * Why a hire could not run on Execution Market right now, or null when it can: EM must publish an escrow for this
 * network that is Flat Fee's own, take `EM_PAYMENT_TOKEN` there (when it lists its tokens), and the SDK must have the
 * chain's escrow row. Checked before the 402, so nobody pays for a hire that cannot be published or funded.
 */
export function escrowReadiness(cfg: Config & { em: EmConfig }, paymentConfig: unknown, sdkRow: (chainId: number) => boolean = sdkHasEscrowRow): string | null {
  try {
    escrowNetwork(cfg, paymentConfig);
  } catch (e) {
    return (e as Error).message;
  }
  const tokens = (paymentConfig as { escrow: { networks: Record<string, { tokens?: unknown }> } }).escrow.networks[cfg.chain.name].tokens;
  if (tokens && typeof tokens === "object" && !Object.keys(tokens).some((k) => k.toUpperCase() === cfg.em.paymentToken.toUpperCase())) {
    return `Execution Market does not take ${cfg.em.paymentToken} on ${cfg.chain.name}`;
  }
  if (!sdkRow(cfg.chain.chainId)) return `uvd-x402-sdk has no escrow row for ${cfg.chain.name} yet, so no escrow can be signed`;
  return null;
}

export interface EscrowDeps {
  cfg: Config & { em: EmConfig };
  wallet: BaseWallet;
  /** the SDK's builder; tests stand in for it where the SDK has no row for the network yet */
  build?: BuildPreAuth;
}

/** reads EM's escrow parameters, checks them, builds and signs the lock for `worker`, and checks what was signed */
export async function escrowPaymentAuth({ cfg, wallet, build = buildEscrowPreAuth }: EscrowDeps, paymentConfig: unknown, worker: string, deadlineSec: number): Promise<string> {
  const networkConfig = escrowNetwork(cfg, paymentConfig);
  let raw: string;
  try {
    raw = await build(typedDataSigner(wallet), {
      networkConfig,
      network: cfg.chain.name,
      payerWallet: wallet.address,
      workerWallet: getAddress(worker.toLowerCase()),
      bountyAtomic: cfg.em.bounty,
      tier: "micro",
      reviewDeadlineSec: deadlineSec,
    });
  } catch (e) {
    throw new EscrowRefused(`the escrow builder refused: ${(e as Error)?.message ?? String(e)}`);
  }
  checkPaymentAuth(cfg, wallet.address, worker, raw);
  return raw;
}
