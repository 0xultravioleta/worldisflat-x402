// `npm run balances`: ETH, USDG and $WIF of the payer and merchant wallets in .env, on the network .env names, through
// its RPC_URL (no public RPC). Prints addresses only.
import { existsSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, USDG_DECIMALS, WIF_DECIMALS, formatUnits, type NetworkName } from "../src/config.js";
import { chainIdOrExit, exitRedacted, keyOrExit, rpcOrExit } from "./lib/env.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const who: [string, string][] = [];
const add = (label: string, keyName?: string, addr?: string) => {
  // keyOrExit checks the key first, so a malformed one is named, never printed
  const a = keyName && process.env[keyName]?.trim() ? new Wallet(keyOrExit(keyName)).address : addr?.trim() && isAddress(addr.trim()) ? getAddress(addr.trim()) : null;
  if (a) who.push([label, a]);
};
add("payer", "PAYER_PRIVATE_KEY");
add("merchant", "MERCHANT_PRIVATE_KEY");
if (!who.some(([, a]) => process.env.PAY_TO && a.toLowerCase() === process.env.PAY_TO.toLowerCase())) add("pay-to", undefined, process.env.PAY_TO);
if (!who.length) {
  console.error("no wallets in .env (PAYER_PRIVATE_KEY, MERCHANT_PRIVATE_KEY, PAY_TO)");
  process.exit(1);
}
const abi = ["function balanceOf(address) view returns (uint256)"];
// the network .env names (testnet when it names none, as the server does) and only that one: RPC_URL is its RPC
const network = (process.env.NETWORK?.trim().toLowerCase() || "robinhood-testnet") as NetworkName;
if (!(network in CHAINS)) {
  console.error(`NETWORK must be robinhood or robinhood-testnet, got "${network}"`);
  process.exit(1);
}
const rpc = rpcOrExit(network);
exitRedacted([rpc]);
await chainIdOrExit(rpc, CHAINS[network]);
for (const c of [CHAINS[network]]) {
  const p = new JsonRpcProvider(rpc, c.chainId, { staticNetwork: true });
  console.log(`\n${c.label} (${c.caip2})`);
  for (const [label, a] of who) {
    const [eth, usdg, wif] = await Promise.all([
      p.getBalance(a),
      new Contract(c.usdg, abi, p).balanceOf(a) as Promise<bigint>,
      c.wif ? (new Contract(c.wif, abi, p).balanceOf(a) as Promise<bigint>) : Promise.resolve(null),
    ]);
    const w = wif === null ? "" : `  ${formatUnits(wif, WIF_DECIMALS)} $WIF`;
    console.log(`  ${label.padEnd(8)} ${a}  ${formatEther(eth)} ETH  ${formatUnits(usdg, USDG_DECIMALS)} USDG${w}`);
  }
}
const other = Object.values(CHAINS).find((c) => c.name !== network)!;
console.log(`\n${other.label}: not read (RPC_URL is ${network}'s; run again with NETWORK=${other.name} and that network's RPC_URL)`);
