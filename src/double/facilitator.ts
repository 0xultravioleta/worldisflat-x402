// A stand-in for the Ultravioleta facilitator, for tests and the fork run only: the same /verify and /settle surface
// for x402 `exact` on USDG, settled with the real `transferWithAuthorization` of the token on whatever chain the RPC
// serves (an anvil fork of Robinhood Chain in `npm run e2e:fork`). It is a double, not a facilitator: it sends from
// an unlocked account of that RPC and has no key handling at all.
import { Hono } from "hono";
import { Contract, Interface, JsonRpcProvider, Signature, getAddress, isAddress, verifyTypedData } from "ethers";
import { USDG_DOMAIN, type ChainInfo } from "../config.js";
import { waitForReceipt } from "../receipt.js";

const USDG_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
];

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface Requirements {
  scheme?: string;
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
  maxAmountRequired?: string;
}

export interface Verdict {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface DoubleOptions {
  chain: ChainInfo;
  rpcUrl: string;
  /** an account the RPC signs for (anvil's unlocked accounts); pays the settlement gas */
  settler: string;
}

export function parseBody(body: unknown): { auth: Authorization; signature: string; req: Requirements } | null {
  const b = body as Record<string, any> | null;
  const payload = b?.paymentPayload?.payload;
  const req: Requirements | undefined = b?.paymentRequirements ?? b?.accepted ?? b?.paymentPayload?.accepted;
  const auth = payload?.authorization;
  if (!auth || typeof payload?.signature !== "string" || !req) return null;
  return { auth, signature: payload.signature, req };
}

export function createFacilitatorDouble({ chain, rpcUrl, settler }: DoubleOptions) {
  const provider = new JsonRpcProvider(rpcUrl, chain.chainId, { staticNetwork: true });
  const usdg = new Contract(chain.usdg, USDG_ABI, provider);
  const iface = new Interface(USDG_ABI);
  const settled: { tx: string; payer: string; value: string }[] = [];

  async function verify(body: unknown): Promise<Verdict & { parsed?: ReturnType<typeof parseBody> }> {
    const parsed = parseBody(body);
    if (!parsed) return { isValid: false, invalidReason: "invalid_payload" };
    const { auth, signature, req } = parsed;
    const fail = (invalidReason: string): Verdict => ({ isValid: false, invalidReason, payer: auth.from });

    if ((req.scheme ?? "exact") !== "exact") return fail("unsupported_scheme");
    if (req.network !== chain.caip2 && req.network !== chain.name) return fail("invalid_network");
    if (!req.asset || req.asset.toLowerCase() !== chain.usdg.toLowerCase()) return fail("invalid_asset");
    for (const a of [auth.from, auth.to, req.payTo]) if (!a || !isAddress(a)) return fail("invalid_payload");
    if (getAddress(auth.to) !== getAddress(req.payTo!)) return fail("invalid_exact_evm_payload_recipient_mismatch");

    let value: bigint, required: bigint, validAfter: bigint, validBefore: bigint;
    try {
      value = BigInt(auth.value);
      required = BigInt(req.amount ?? req.maxAmountRequired ?? "");
      validAfter = BigInt(auth.validAfter);
      validBefore = BigInt(auth.validBefore);
    } catch {
      return fail("invalid_payload");
    }
    if (value !== required) return fail("invalid_exact_evm_payload_authorization_value");

    const block = await provider.getBlock("latest");
    const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
    if (now < validAfter) return fail("invalid_exact_evm_payload_authorization_valid_after");
    if (now >= validBefore) return fail("invalid_exact_evm_payload_authorization_valid_before");

    let signer: string;
    try {
      signer = verifyTypedData(
        { ...USDG_DOMAIN, chainId: chain.chainId, verifyingContract: chain.usdg },
        TYPES,
        { ...auth, value, validAfter, validBefore },
        signature,
      );
    } catch {
      return fail("invalid_exact_evm_payload_signature");
    }
    if (getAddress(signer) !== getAddress(auth.from)) return fail("invalid_exact_evm_payload_signature");

    if ((await usdg.authorizationState(auth.from, auth.nonce)) as boolean) return fail("authorization_already_used");
    if (((await usdg.balanceOf(auth.from)) as bigint) < value) return fail("insufficient_funds");
    return { isValid: true, payer: getAddress(auth.from), parsed };
  }

  const app = new Hono();
  app.onError((err, c) => {
    console.error(`facilitator double: ${err.message}`);
    return c.json({ error: err.message }, 500);
  });
  app.get("/supported", (c) =>
    c.json({
      kinds: [
        { x402Version: 1, scheme: "exact", network: chain.name },
        { x402Version: 2, scheme: "exact", network: chain.caip2 },
      ],
    }),
  );
  app.post("/verify", async (c) => {
    const { parsed: _, ...verdict } = await verify(await c.req.json().catch(() => null));
    return c.json(verdict);
  });
  app.post("/settle", async (c) => {
    const v = await verify(await c.req.json().catch(() => null));
    if (!v.isValid || !v.parsed) return c.json({ success: false, errorReason: v.invalidReason, payer: v.payer, network: chain.caip2 });
    const { auth, signature } = v.parsed;
    const sig = Signature.from(signature).serialized;
    const data = iface.encodeFunctionData("transferWithAuthorization", [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig]);
    const hash = (await provider.send("eth_sendTransaction", [{ from: settler, to: chain.usdg, data }])) as string;
    const receipt = await waitForReceipt(provider, hash, 20_000);
    if (receipt.status !== 1) {
      return c.json({ success: false, errorReason: "settlement_reverted", transaction: hash, payer: v.payer, network: chain.caip2 });
    }
    settled.push({ tx: hash, payer: v.payer!, value: auth.value });
    return c.json({ success: true, transaction: hash, network: chain.caip2, payer: v.payer });
  });

  return { app, settled, verify };
}
