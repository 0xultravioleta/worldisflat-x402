// The paid agent: answers questions about Robinhood Chain from live chain reads. Deterministic, no API keys.
import { Contract, formatEther, getAddress } from "ethers";
import type { Chain } from "./chain.js";
import { USDG_DECIMALS, WIF_DECIMALS, formatUnits, type Config } from "./config.js";

export interface Answer {
  answer: string;
  facts: Record<string, string>;
  skill: "address" | "block" | "wif" | "facilitator" | "help";
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

export function pickSkill(question: string): Answer["skill"] {
  const q = question.toLowerCase();
  if (ADDRESS_RE.test(question)) return "address";
  if (/\b(wif|world is flat)\b/.test(q)) return "wif";
  if (/\b(facilitator|x402|settle|networks?)\b/.test(q)) return "facilitator";
  if (/\b(block|gas|fee|height|chain)\b/.test(q)) return "block";
  return "help";
}

export async function answer(question: string, cfg: Config, chain: Chain): Promise<Answer> {
  const skill = pickSkill(question);
  const label = cfg.chain.label;
  switch (skill) {
    case "address": {
      const who = getAddress(ADDRESS_RE.exec(question)![0].toLowerCase());
      const [eth, usdg, wif, tier] = await Promise.all([
        chain.provider.getBalance(who),
        chain.balanceOf(cfg.chain.usdg, who),
        cfg.wif.token ? chain.balanceOf(cfg.wif.token, who) : Promise.resolve(null),
        chain.tierOf(who),
      ]);
      const facts: Record<string, string> = {
        address: who,
        eth: formatEther(eth),
        usdg: formatUnits(usdg, USDG_DECIMALS),
        tier,
      };
      if (wif !== null) facts.wif = formatUnits(wif, WIF_DECIMALS);
      const wifPart = wif === null ? "" : `, ${facts.wif} $WIF`;
      return {
        skill,
        facts,
        answer: `On ${label}, ${who} holds ${facts.eth} ETH, ${facts.usdg} USDG${wifPart}. Flat Fee prices it at the ${tier} tier.`,
      };
    }
    case "block": {
      const block = await chain.provider.getBlock("latest");
      if (!block) throw new Error("the RPC returned no latest block");
      const baseFee = block.baseFeePerGas ?? 0n;
      const facts = {
        block: block.number.toString(),
        timestamp: new Date(block.timestamp * 1000).toISOString(),
        baseFeeGwei: formatUnits(baseFee, 9),
      };
      return {
        skill,
        facts,
        answer: `${label} is at block ${facts.block} (${facts.timestamp}); the base fee is ${facts.baseFeeGwei} gwei.`,
      };
    }
    case "wif": {
      if (!cfg.wif.token) {
        return { skill, facts: {}, answer: `$WIF is not configured on ${label}. Set WIF_ADDRESS to enable it.` };
      }
      const wif = new Contract(cfg.wif.token, ["function totalSupply() view returns (uint256)"], chain.provider);
      const supply = (await wif.totalSupply()) as bigint;
      const facts = {
        token: cfg.wif.token,
        totalSupply: formatUnits(supply, WIF_DECIMALS),
        holderMin: formatUnits(cfg.wif.holderMin, WIF_DECIMALS),
        cashbackPerCall: formatUnits(cfg.wif.cashback, WIF_DECIMALS),
        askPrice: formatUnits(cfg.prices.ask, USDG_DECIMALS),
        askHolderPrice: formatUnits(cfg.prices.askHolder, USDG_DECIMALS),
      };
      const cashback = cfg.wif.cashback > 0n ? ` Each paid call sends ${facts.cashbackPerCall} $WIF back to the payer.` : "";
      return {
        skill,
        facts,
        answer:
          `$WIF (${facts.token}) has a total supply of ${facts.totalSupply}. ` +
          `Hold ${facts.holderMin} $WIF and a question costs ${facts.askHolderPrice} USDG instead of ${facts.askPrice}.${cashback}`,
      };
    }
    case "facilitator": {
      const res = await fetch(`${cfg.facilitatorUrl}/supported`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`facilitator /supported answered ${res.status}`);
      const body = (await res.json()) as { kinds?: { scheme: string; network: string; x402Version: number }[] };
      const kinds = (body.kinds ?? []).filter((k) => k.network === cfg.chain.caip2 || k.network === cfg.chain.name);
      const schemes = [...new Set(kinds.map((k) => `${k.scheme} (x402 v${k.x402Version})`))];
      const facts = { facilitator: cfg.facilitatorUrl, network: cfg.chain.caip2, schemes: schemes.join(", ") || "none" };
      return {
        skill,
        facts,
        answer: schemes.length
          ? `The facilitator at ${facts.facilitator} settles ${label} (${facts.network}) with: ${facts.schemes}.`
          : `The facilitator at ${facts.facilitator} does not list ${label} right now.`,
      };
    }
    default:
      return {
        skill: "help",
        facts: {},
        answer:
          `I answer questions about ${label} from live chain data. Ask me about an address (0x...), ` +
          `the latest block and gas, $WIF, or which x402 schemes the facilitator settles here.`,
      };
  }
}
