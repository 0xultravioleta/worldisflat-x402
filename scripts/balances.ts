// `npm run balances`: ETH, USDG and $WIF of the payer and merchant wallets in .env, on both networks. Prints addresses only.
import { existsSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, USDG_DECIMALS, WIF_DECIMALS, formatUnits } from "../src/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const who: [string, string][] = [];
const add = (label: string, key?: string, addr?: string) => {
  const a = key?.trim() ? new Wallet(key.trim()).address : addr?.trim() && isAddress(addr.trim()) ? getAddress(addr.trim()) : null;
  if (a) who.push([label, a]);
};
add("payer", process.env.PAYER_PRIVATE_KEY);
add("merchant", process.env.MERCHANT_PRIVATE_KEY);
if (!who.some(([, a]) => process.env.PAY_TO && a.toLowerCase() === process.env.PAY_TO.toLowerCase())) add("pay-to", undefined, process.env.PAY_TO);
if (!who.length) {
  console.error("no wallets in .env (PAYER_PRIVATE_KEY, MERCHANT_PRIVATE_KEY, PAY_TO)");
  process.exit(1);
}
const abi = ["function balanceOf(address) view returns (uint256)"];
for (const c of Object.values(CHAINS)) {
  const p = new JsonRpcProvider(c.rpcUrl, c.chainId, { staticNetwork: true });
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
