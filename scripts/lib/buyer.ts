// The buyer side, as an agent would run it: read the 402, check the price, sign with the SDK, call again with X-PAYMENT.
import { X402Client } from "uvd-x402-sdk";
import { CHAINS, USDG_DECIMALS, formatUnits, parseUnitsStrict, type NetworkName } from "../../src/config.js";

export interface BuyOptions {
  url: string;
  body: Record<string, string>;
  network: NetworkName;
  key: string;
  /** the most this buyer signs, in USDG ("0.10"); a 402 asking for more is refused before anything is signed */
  maxAmount: string;
  /** on mainnet the exact amount the owner approved; the 402 must ask for exactly this or nothing is signed */
  confirmMainnet?: string | null;
  payer?: string;
  rpcUrl?: string;
}

export interface Bought {
  status: number;
  price: string;
  body: Record<string, any>;
}

/** true when `approved` ("0.10", "0.1") is exactly `atomic` at `decimals`; anything unparsable is a no */
export function confirms(approved: string | null | undefined, atomic: bigint, decimals: number): boolean {
  if (!approved) return false;
  try {
    return parseUnitsStrict(approved, decimals) === atomic;
  } catch {
    return false;
  }
}

export async function quote(url: string, body: Record<string, string>, payer?: string) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(payer ? { "x-payer": payer } : {}) },
    body: JSON.stringify(body),
  });
  if (r.status !== 402) throw new Error(`expected 402 Payment Required, got ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const terms = (await r.json()) as { accepts: { network: string; asset: string; amount: string; payTo: string }[] };
  return terms.accepts[0];
}

export async function buy(o: BuyOptions): Promise<Bought> {
  const offer = await quote(o.url, o.body, o.payer);
  const price = formatUnits(BigInt(offer.amount), USDG_DECIMALS);
  const chain = CHAINS[o.network];
  if (offer.network !== chain.caip2 || offer.asset.toLowerCase() !== chain.usdg.toLowerCase()) {
    throw new Error(`the 402 asks for ${offer.asset} on ${offer.network}, not USDG on ${chain.caip2}: refusing to sign`);
  }
  let maxAmount = o.maxAmount;
  if (o.network === "robinhood") {
    maxAmount = price; // the SDK re-reads the 402 before signing: never let it sign more than what was approved
    // mainnet spends real USDG: only the exact amount the owner approved, never "up to"
    if (!confirms(o.confirmMainnet, BigInt(offer.amount), USDG_DECIMALS)) {
      throw new Error(`mainnet: the 402 asks ${price} USDG to ${offer.payTo}. Re-run with CONFIRM_MAINNET_SPEND=${price} once that exact amount is approved.`);
    }
  }
  const client = new X402Client({ defaultChain: o.network, ...(o.rpcUrl ? { rpcOverrides: { [o.network]: o.rpcUrl } } : {}) });
  await client.connectWithPrivateKey(o.key, o.network);
  const r = await client.fetch(o.url, {
    method: "POST",
    maxAmount,
    init: { headers: { "content-type": "application/json", ...(o.payer ? { "x-payer": o.payer } : {}) }, body: JSON.stringify(o.body) },
  });
  const text = await r.text();
  let body: Record<string, any>;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: r.status, price, body };
}
