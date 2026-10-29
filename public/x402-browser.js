// Builds an x402 v2 `exact` payment for USDG (EIP-3009 TransferWithAuthorization), the same payload the SDK sends.
// Plain ES module with no dependencies, so the page and the Node e2e use the very same code.

export function chainIdOf(network) {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`not an EVM CAIP-2 network: ${network}`);
  return Number(m[1]);
}

export function randomNonce() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** the EIP-712 typed data a wallet signs for this 402 offer */
export function typedDataFor(accept, from, { now = Math.floor(Date.now() / 1000), nonce = randomNonce() } = {}) {
  const extra = accept.extra || {};
  if (!extra.name || !extra.version) throw new Error("the 402 offer has no EIP-712 domain (extra.name / extra.version)");
  return {
    domain: { name: extra.name, version: extra.version, chainId: chainIdOf(accept.network), verifyingContract: accept.asset },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: accept.payTo,
      value: String(accept.amount),
      validAfter: "0",
      validBefore: String(now + Math.min(Number(accept.maxTimeoutSeconds) || 300, 3600)),
      nonce,
    },
  };
}

/** the X-PAYMENT header value: base64 of the v2 payment, in the shape the SDK's own client sends */
export function paymentHeader(accept, typed, signature) {
  const json = JSON.stringify({
    x402Version: 2,
    scheme: accept.scheme || "exact",
    network: accept.network,
    payload: { signature, authorization: typed.message },
  });
  return typeof btoa === "function" ? btoa(json) : Buffer.from(json, "utf8").toString("base64");
}
