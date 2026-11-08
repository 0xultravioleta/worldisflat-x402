// What every script reads from .env, with errors that name the variable and never print a key.
import { JsonRpcProvider } from "ethers";
import { safeMessage } from "../../src/app.js";
import { ConfigError, loadConfig, privateKey, rpcUrlFor, type ChainInfo, type Config, type NetworkName } from "../../src/config.js";

type Env = Record<string, string | undefined>;

/** loadConfig, or a one-line message and exit 1 */
export function configOrExit(env: Env = process.env): Config {
  try {
    return loadConfig(env);
  } catch (e) {
    console.error(`config: ${e instanceof ConfigError ? e.message : "unreadable"}\nCopy .env.example to .env and fill it in (see README).`);
    process.exit(1);
  }
}

/** the RPC_URL of `network` (rpcUrlFor: required, and the one NETWORK names), or a one-line message and exit 1 */
export function rpcOrExit(network: NetworkName, env: Env = process.env, why = ""): string {
  try {
    return rpcUrlFor(env, network);
  } catch (e) {
    console.error(`${e instanceof ConfigError ? e.message : "RPC_URL could not be read; the value is not shown"}${why ? `\n${why}` : ""}`);
    process.exit(1);
  }
}

/**
 * From here on, an error nobody caught is printed without `secrets` (RPC_URL can carry an API key, and ethers puts the
 * request URL in its errors) and without any other URL, then exit 1.
 */
export function exitRedacted(secrets: (string | null | undefined)[]): void {
  const out = (e: unknown) => {
    console.error(`error: ${safeMessage(e, secrets)}`);
    process.exit(1);
  };
  process.on("uncaughtException", out);
  process.on("unhandledRejection", out);
}

/** RPC_URL must answer `chain`'s id (eth_chainId) before anything is read or paid through it, or a one-line message and exit 1 */
export async function chainIdOrExit(rpc: string, chain: ChainInfo): Promise<void> {
  const p = new JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });
  let id: bigint;
  try {
    id = BigInt((await p.send("eth_chainId", [])) as string);
  } catch (e) {
    console.error(`RPC_URL could not be read: ${safeMessage(e, [rpc])}`);
    process.exit(1);
  } finally {
    p.destroy();
  }
  if (id !== BigInt(chain.chainId)) {
    console.error(`RPC_URL answers chain ${id}, not ${chain.label} (${chain.chainId}): set the RPC of ${chain.name}`);
    process.exit(1);
  }
}

/** a private key that must be set, or a one-line message and exit 1 */
export function keyOrExit(name: string, env: Env = process.env): string {
  let key: string | null = null;
  try {
    key = privateKey(env, name);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `${name} could not be read; the value is not shown`);
    process.exit(1);
  }
  if (!key) {
    console.error(`${name} is not set in .env`);
    process.exit(1);
  }
  return key;
}
