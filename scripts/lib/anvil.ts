// Starts anvil on a fork of Robinhood Chain and gives the helpers the fork run needs (impersonated funding, balances).
import { spawn, type ChildProcess } from "node:child_process";
import { Contract, JsonRpcProvider, getAddress, toBeHex } from "ethers";
import { waitForReceipt } from "../../src/receipt.js";

export interface Fork {
  url: string;
  provider: JsonRpcProvider;
  /** anvil's first unlocked account */
  settler: string;
  stop(): void;
}

export async function startFork(forkUrl: string, chainId: number, port: number): Promise<Fork> {
  let child: ChildProcess;
  try {
    child = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port), "--chain-id", String(chainId), "--silent"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error("anvil not found: install Foundry (https://book.getfoundry.sh) to run the fork e2e");
  }
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const exited = new Promise<never>((_, reject) => {
    child.on("error", () => reject(new Error("anvil not found: install Foundry (https://book.getfoundry.sh)")));
    child.on("exit", (code) => reject(new Error(`anvil exited (${code}): ${stderr.slice(0, 400)}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, chainId, { staticNetwork: true, pollingInterval: 200 });
  const deadline = Date.now() + 60_000;
  const ready = (async () => {
    for (;;) {
      try {
        await provider.getBlockNumber();
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("anvil did not answer within 60 s");
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  })();
  await Promise.race([ready, exited]);
  const [settler] = (await provider.send("eth_accounts", [])) as string[];
  return { url, provider, settler, stop: () => child.kill("SIGTERM") };
}

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

/** move `amount` of `token` from `holder` to `to` on the fork, by impersonating the holder (fork only, never a real chain) */
export async function fundFromHolder(fork: Fork, token: string, holder: string, to: string, amount: bigint) {
  const p = fork.provider;
  await p.send("anvil_impersonateAccount", [holder]);
  await p.send("anvil_setBalance", [holder, toBeHex(10n ** 18n)]);
  const data = new Contract(token, ERC20).interface.encodeFunctionData("transfer", [getAddress(to), amount]);
  const hash = await p.send("eth_sendTransaction", [{ from: holder, to: token, data }]);
  const r = await waitForReceipt(p, hash, 30_000);
  await p.send("anvil_stopImpersonatingAccount", [holder]);
  if (r.status !== 1) throw new Error(`funding ${to} from ${holder} reverted`);
}

export async function setEth(fork: Fork, who: string, wei: bigint) {
  await fork.provider.send("anvil_setBalance", [who, toBeHex(wei)]);
}

export async function balance(fork: Fork, token: string, who: string): Promise<bigint> {
  return (await new Contract(token, ERC20, fork.provider).balanceOf(who)) as bigint;
}
