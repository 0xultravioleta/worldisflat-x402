// `npm run e2e:hire`: one real hire through Execution Market on Robinhood Chain mainnet, against a running Flat Fee
// with EM_HIRE on (FLATFEE_URL, the deploy). The PAYER_PRIVATE_KEY wallet pays the hire over x402, Flat Fee publishes
// it on Execution Market, the test worker applies, the merchant's escrow locks the bounty, the worker delivers a text
// answer, Flat Fee approves it, the escrow pays the worker and Flat Fee sends the worker its $WIF. Every transaction
// and every status the task went through is printed, then checked on chain. The rules (scripts/lib/hire.ts) stop the
// run before it reads the chain or signs anything unless every amount it can move is approved:
//
//   (.env as for e2e:mainnet: NETWORK=robinhood, PAY_TO, WIF_CASHBACK=10, MERCHANT_PRIVATE_KEY, PAYER_PRIVATE_KEY, and
//   RPC_URL, the private RPC: a public one is refused)
//   FLATFEE_URL=https://flatfee.ultravioletadao.xyz WORKER_MODE=manual WORKER_WALLET=0x...
//   CONFIRM_MAINNET_SPEND=0.25 CONFIRM_MAINNET_BOUNTY=0.20 CONFIRM_MAINNET_REWARD=50 CONFIRM_MAINNET_WIF=10 npm run e2e:hire
//
// CONFIRM_MAINNET_SPEND is what the buyer pays (the hire price of its tier, as the server quotes it), BOUNTY what the
// merchant locks in escrow, REWARD the worker's $WIF and WIF the buyer's $WIF cashback; each must match the server.
// The worker (WORKER_MODE): `manual`, a person on execution.market with the payout wallet WORKER_WALLET, applies and
// delivers the text the run prints; `token`, the script does it with that person's dashboard session (WORKER_EM_TOKEN);
// `erc8128`, the script signs with WORKER_PRIVATE_KEY (and WORKER_EM_CLIENT, see scripts/lib/emworker.ts). Optional:
// EM_API_URL (https://api.execution.market), E2E_REQUEST, E2E_ANSWER, E2E_TIMEOUT_MINUTES, E2E_POLL_SECONDS.
// No key and no RPC URL is ever printed; errors go through safeMessage.
import { existsSync } from "node:fs";
import { Wallet } from "ethers";
import { safeMessage } from "../src/app.js";
import { connectChain } from "../src/chain.js";
import { privateKey, txUrl } from "../src/config.js";
import { buy } from "./lib/buyer.js";
import { emWorker } from "./lib/emworker.js";
import { configOrExit, keyOrExit } from "./lib/env.js";
import { hirePlanRefusal, remoteHireRefusal, runHire } from "./lib/hire.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const cfg = configOrExit(process.env);
const key = keyOrExit("PAYER_PRIVATE_KEY");
const payer = new Wallet(key).address;
const redact = (e: unknown) => safeMessage(e, [cfg.rpcUrl, process.env.WORKER_EM_TOKEN]);
const stop = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const planned = hirePlanRefusal(cfg, process.env, payer);
if ("refusal" in planned) stop(planned.refusal);
const plan = (planned as Extract<typeof planned, { plan: unknown }>).plan;

const getJson = async (url: string): Promise<unknown> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${new URL(url).pathname} answered ${r.status}`);
  return r.json();
};

// the running server and its quote for this buyer, before anything is signed
let info: any;
let price: string | null = null;
try {
  info = await getJson(`${plan.flatfee}/api/info`);
  const q = (await getJson(`${plan.flatfee}/api/quote?payer=${payer}`)) as { hire?: unknown };
  price = typeof q.hire === "string" ? q.hire : null;
} catch (e) {
  stop(`FLATFEE_URL: cannot read ${plan.flatfee}: ${redact(e)}`);
}
const mismatch = remoteHireRefusal(cfg, info, plan, price);
if (mismatch) stop(mismatch);

// EM's fee bounds, to check what the escrow pays the worker
let fees = { maxBps: 1800, pct: null as number | null };
try {
  const pc = (await getJson(`${plan.emApi}/api/v1/h2a/payment-config`)) as { fee_pct?: unknown; escrow?: { max_fee_bps?: unknown } };
  if (Number.isInteger(pc.escrow?.max_fee_bps)) fees.maxBps = pc.escrow!.max_fee_bps as number;
  if (typeof pc.fee_pct === "number") fees.pct = pc.fee_pct;
} catch (e) {
  console.error(`Execution Market's payment-config could not be read (${redact(e)}); checking the worker's payout against an 18% fee at most`);
}

const chain = connectChain(cfg);
const worker =
  plan.mode === "manual"
    ? null
    : emWorker({
        apiUrl: plan.emApi,
        auth:
          plan.mode === "token"
            ? { kind: "token", token: process.env.WORKER_EM_TOKEN!.trim(), address: plan.worker }
            : { kind: "erc8128", wallet: new Wallet(privateKey(process.env, "WORKER_PRIVATE_KEY")!), chainId: cfg.chain.chainId, client: process.env.WORKER_EM_CLIENT!.trim() },
      });

console.log(`${cfg.chain.label} (${cfg.chain.caip2}): hire on ${plan.flatfee} through Execution Market (${plan.emApi})`);
console.log(`buyer ${payer} pays ${plan.approved.spend} USDG; the merchant locks ${plan.approved.bounty} USDG for the worker ${plan.worker} (${plan.mode}); reward ${plan.approved.reward} $WIF`);

let ok = false;
try {
  const outcome = await runHire(plan, cfg, {
    flatfee: (p) => getJson(`${plan.flatfee}${p}`),
    pay: async (body) => {
      const r = await buy({
        url: `${plan.flatfee}/api/hire`,
        body,
        network: "robinhood",
        key,
        payer,
        maxAmount: plan.approved.spend,
        confirmMainnet: plan.approved.spend,
        expectPayTo: cfg.payTo,
        // the buyer's SDK client reads the chain through the private RPC too
        rpcUrl: cfg.rpcUrl,
      });
      return { status: r.status, body: r.body };
    },
    worker,
    balances: {
      usdg: (a) => chain.balanceOf(cfg.chain.usdg, a),
      wif: (a) => (cfg.wif.token ? chain.balanceOf(cfg.wif.token, a) : Promise.resolve(0n)),
    },
    payer,
    payTo: cfg.payTo,
    explorerTx: (h) => txUrl(cfg.chain, h),
    fees,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
  });
  console.log("\n" + JSON.stringify({ ...outcome, deltas: outcome.deltas && Object.fromEntries(Object.entries(outcome.deltas).map(([k, v]) => [k, v.toString()])) }, null, 2));
  for (const p of outcome.problems) console.error(`FAIL  ${p}`);
  ok = outcome.ok;
  console.log(ok ? `PASS  hire ${outcome.taskId} (EM ${outcome.emTaskId}): ${plan.approved.spend} USDG paid, the escrow paid the worker, $WIF sent` : "FAIL");
} catch (e) {
  console.error(redact(e));
}
process.exit(ok ? 0 : 1);
