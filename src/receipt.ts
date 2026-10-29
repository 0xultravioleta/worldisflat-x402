// Polls for a receipt instead of waiting for a new block: a local anvil fork only mines when a transaction arrives,
// so ethers' block-driven wait can sit forever on a receipt that was simply not there yet at its first look.
import type { JsonRpcProvider, TransactionReceipt } from "ethers";

export async function waitForReceipt(provider: JsonRpcProvider, hash: string, timeoutMs = 60_000, intervalMs = 250): Promise<TransactionReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await provider.send("eth_getTransactionReceipt", [hash]);
    if (raw) {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    }
    if (Date.now() > deadline) throw new Error(`no receipt for ${hash} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
