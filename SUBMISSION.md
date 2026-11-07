# SUBMISSION: Flat Fee (world is flat hackathon)

> **SUBMITTED 2 Nov 2026, 16:55 UTC** by Saúl on worldisflat.fun (team UltravioletaDAO, status "submitted"). Edits stay open until 12 Nov 2026, 17:30 UTC via "edit submission". Integration type ticked: *holding $wif unlocks something* + *other*; contract addresses left empty (we deploy none); "ok with wif featuring" ticked.

- **Submit at:** https://worldisflat.fun/build → sign in → start a team → submission (Saúl does every click; nobody else
  registers, saves or submits).
- **Submissions close:** Thu 12 Nov 2026, 17:30 UTC (extended from 2 Nov; round one 12-14 Nov, final 14-16 Nov). Edits lock then;
  only the logo can change until the final (14-16 Nov 2026).
- **The project must stay live and working through the final (14-16 Nov 2026)**: judges try it.
- The form's steps, from the site's own copy: your team → your project → how it connects to $wif → your flywheel →
  proof of build → review. The site shows no character limits publicly; lengths are given so you can trim if a field asks.
- Replace every `[PLACEHOLDER]` first. Rules that shaped this: the name cannot use Robinhood's name or logo; the project
  must use $wif on chain on Robinhood Chain and have a flywheel; proof = a repo the judges can see, a demo video and real
  transactions.

## Edit before 12 Nov 2026, 17:30 UTC: hiring through Execution Market (ready to paste)

The texts below replace the hiring parts of the submitted answers, now that "hire a human" runs through Execution Market
on the live demo (`EM_HIRE=on`, [docs/EXECUTION-MARKET.md](docs/EXECUTION-MARKET.md)). The three things they waited for
all hold as of 7 Nov 2026: Execution Market takes Robinhood Chain escrows (USDG); the live demo runs with `EM_HIRE=on`
(`GET https://flatfee.ultravioletadao.xyz/api/info` answers `hire.via: "execution-market"`); and one hire on mainnet,
paid in real USDG, produced the escrow lock, its release to the worker and the worker's $WIF, whose links go under
*Transactions* below (the whole run: [README, *A hire through Execution
Market*](README.md#a-hire-through-execution-market-7-nov-2026)). **The worker in this run is a test wallet of the team,
driven by a script, that declares itself to Execution Market as a PayBox client (`human_via_agent`); it is not a person
and not a real customer.** The buyer is the team's payer wallet too. Every text below that cites the run says so. Until
they are pasted, the form shows the submitted texts further down. Saúl or c0der edit the form; nothing here was sent.

| field | replace with | length |
|---|---|---|
| One liner | `Ask an agent or hire a human via Execution Market, flat USDG fee, $WIF back` | 75 chars (the form allows 80) |
| What it does | the block below | 589 chars |
| How it connects to $wif | its point 3) becomes the line below | 137 chars for that point |
| What happens to $wif | the line below | 150 chars |
| Why they come back | the line below | 193 chars |
| Transactions | add the block below after the two lines already there | 1303 chars |
| Wallets | add the block below after the two lines already there | 485 chars |
| Long story, *What it does* | the block below | 1010 chars |
| Long story, *Accomplishments* | add the block below after the paragraph already there | 1206 chars |
| Long story, *What's next* | the line below | 196 chars |

*What it does*:

```text
Flat Fee turns an HTTP endpoint into a storefront on Robinhood Chain. Ask the agent a question (live chain data: balances, blocks, gas, $WIF) or hire a human for a small task through Execution Market. The endpoint answers 402 Payment Required with a price in USDG; your wallet or agent signs one EIP-3009 authorization, Ultravioleta's x402 facilitator settles it on chain, and the answer comes back. For a hire, Flat Fee publishes the task on Execution Market, locks the worker's pay in a USDG escrow and approves the answer. Paid calls send $WIF back, holders pay half, workers earn $WIF.
```

*How it connects to $wif*, point 3):

```text
3) Workers: a human hired through Execution Market whose answer Flat Fee approves is paid by the USDG escrow and receives 50 $WIF on top.
```

*What happens to $wif*:

```text
The merchant sends the payer 10 $WIF after a settled call, up to 500 $WIF a day, and 50 $WIF to each Execution Market worker whose answer it approves.
```

*Why they come back*:

```text
Ten paid calls make you a $WIF holder, and holders pay half on every call after that. Execution Market workers return for tasks paid in USDG escrow plus $WIF, which buys them the cheaper price.
```

*Transactions*, added after the two lines already there:

```text
Hire through Execution Market, 7 Nov 2026. The worker in this run is a test wallet of the team, driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person and not a real customer. The buyer is the team's payer wallet.
The hire, payer to merchant via the x402 facilitator (0.25 USDG, the holder price): https://robinhoodchain.blockscout.com/tx/0xffea67a1b62bfc374682ca3a36e19fb9be7c4997e3c53a8937024f10bdcedd54
$WIF cashback to the payer (10 $WIF): https://robinhoodchain.blockscout.com/tx/0xf4318a5ef5871332a7b029e66f3315cc161e1ffe03267c1ad04662546cad030a
Bounty locked in Execution Market's USDG escrow by the merchant (0.20 USDG): https://robinhoodchain.blockscout.com/tx/0x4eae3196450ccbfff305bd9dbdd114005a8c37c0ed4d088c704b62231e1643d9
Escrow released to the test worker (0.174 USDG: the 0.20 bounty less Execution Market's 13% fee): https://robinhoodchain.blockscout.com/tx/0xe72bca30f5cf8c183525889de728d0799fe462f77164bba762858505b7bfe346
$WIF reward to the test worker (50 $WIF): https://robinhoodchain.blockscout.com/tx/0xde1aa451397d68bfa3a1e12ad0a57cadb60dc3c36a8d316bd5a7decbc37fade6
The task on Execution Market (3175424d-4f83-45cc-b871-92d9dcd3ffe3): https://api.execution.market/api/v1/tasks/3175424d-4f83-45cc-b871-92d9dcd3ffe3
```

*Wallets*, added after the two lines already there:

```text
Test worker (a team wallet driven by a script, not a person): 0xa329b5FB85cf76E1d235711AFc096B76374271c7
Merchant's ERC-8004 identity on Base, which Execution Market requires of every publisher: agent 1170265, minted by Ultravioleta's facilitator, which paid the gas (https://basescan.org/tx/0x53234d1747e29f3fb73b7bb1a06e2dce77bcdd2cfde54b8f7348389fb46682c8), and transferred to the merchant (https://basescan.org/tx/0xf79f1e26efa7d1da49a7b46067200f7b93c4ef7a5b34041b3bb79c0e39fb74a6)
```

Long story, *What it does*:

```text
An HTTP endpoint answers 402 Payment Required with a price in USDG on Robinhood Chain. A wallet or an agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles it on chain, and the endpoint answers the question, or hires a human through Execution Market: Flat Fee publishes the task there, its wallet locks the worker's pay in a USDG escrow on Robinhood Chain, and Flat Fee approves the answer, which releases the escrow to the worker. Paid calls send $WIF back, up to a daily budget; $WIF holders who name their wallet pay half; workers whose answer Flat Fee approves earn 50 $WIF on top. Before anyone pays for a hire, the server says what happens if nobody takes it: "The task is on Execution Market, for any of its people to take. If no one takes it within 24 h, it expires there, with nothing locked for it. If the person who takes it does not deliver by then, Execution Market returns the escrowed pay to Flat Fee's wallet. Either way, the fee you paid is not refunded."
```

Long story, *Accomplishments*, added after the paragraph already there:

```text
On 7 Nov 2026 one hire bought from the live demo ran through Execution Market end to end on Robinhood Chain mainnet: the team's payer wallet paid 0.25 USDG over x402 (https://robinhoodchain.blockscout.com/tx/0xffea67a1b62bfc374682ca3a36e19fb9be7c4997e3c53a8937024f10bdcedd54), Flat Fee published the task on Execution Market, the merchant locked the 0.20 USDG bounty in escrow (https://robinhoodchain.blockscout.com/tx/0x4eae3196450ccbfff305bd9dbdd114005a8c37c0ed4d088c704b62231e1643d9), Flat Fee approved the delivered text and the escrow paid the worker 0.174 USDG, the bounty less Execution Market's 13% fee (https://robinhoodchain.blockscout.com/tx/0xe72bca30f5cf8c183525889de728d0799fe462f77164bba762858505b7bfe346), and Flat Fee sent the worker 50 $WIF (https://robinhoodchain.blockscout.com/tx/0xde1aa451397d68bfa3a1e12ad0a57cadb60dc3c36a8d316bd5a7decbc37fade6) and the buyer 10 $WIF cashback (https://robinhoodchain.blockscout.com/tx/0xf4318a5ef5871332a7b029e66f3315cc161e1ffe03267c1ad04662546cad030a). The worker in this run is a test wallet of the team, driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person and not a real customer.
```

Long story, *What's next*:

```text
Ratings of every Execution Market task written on Robinhood Chain (ERC-8004), once the SDK Execution Market runs on can relay them there; an LLM behind the agent; and subscriptions priced in $WIF.
```

## 1. Your team

```text
Team: Ultravioleta DAO
Lead (prize wallet): Saúl ([SAUL_FULL_NAME], @[SAUL_X_HANDLE]), wallet [SAUL_WALLET_PUBLIC_ADDRESS]
Members: add c0der ([C0DER_NAME]) only if Saúl decides. Up to 4 people; each person can be on one team only.
```

## 2. Your project

### Project name · 8 chars
```text
Flat Fee
```

### One liner · 78 chars (the form allows 80)
```text
Ask an agent or hire a human for a flat USDG fee on Robinhood Chain, $WIF back
```

### Project logo
`docs/video/logo.png` (square, 1024×1024)

### Categories (the first one is the main one)
```text
agents and ai, consumer and payments, tools and infra
```

### What it does · 578 chars
```text
Flat Fee turns an HTTP endpoint into a storefront on Robinhood Chain. Ask the agent a question (live chain data: balances, blocks, gas, $WIF) or hire a human for a small task. The endpoint answers 402 Payment Required with a price in USDG; your wallet or agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles the USDG on chain, and the answer comes back. Paid calls send $WIF back to the payer (up to a daily budget), $WIF holders pay half, and the humans who complete tasks are paid in $WIF. No accounts, no API keys, no gas for the buyer.
```

### Who it's for · 247 chars
```text
AI agents and people who want to buy one answer or one errand at a time, for cents, with any wallet; and builders who want any API to charge in USDG on Robinhood Chain without accounts or API keys. Humans nearby earn $WIF by completing paid tasks.
```

## 3. How it connects to $wif · 567 chars
```text
$WIF (0x5173b8ea6923c2d40267890d45c46a3480954773) is on chain on Robinhood Chain in the paid calls. 1) Cashback: after a USDG settlement, the merchant wallet transfers 10 $WIF to the payer, up to 500 $WIF a day. 2) Holder price: a buyer that names its wallet before paying (the landing page does) is quoted from its $WIF balance on chain; with 100 $WIF or more a question costs 0.05 USDG instead of 0.10. The price is then checked against the address that signed the payment, so a header cannot fake it. 3) Workers: a human who completes a hire task receives 50 $WIF.
```

## 4. Your flywheel

### What someone does · 85 chars
```text
Pays a flat USDG fee to ask the agent a question or to hire a human for a small task.
```

### What happens to $wif · 155 chars
```text
The merchant sends 10 $WIF back to the payer on Robinhood Chain after a settled call, up to 500 $WIF a day, and 50 $WIF to each human who completes a task.
```

### Why they come back · 172 chars
```text
Ten paid calls make you a $WIF holder, and holders pay half on every call after that. Workers come back for more tasks paid in $WIF, which also buys them the cheaper price.
```

## 5. Proof of build

### Links
```text
Live product: https://flatfee.ultravioletadao.xyz
Demo video: https://youtu.be/oRGfZMNiinI
Repo: https://github.com/0xultravioleta/worldisflat-x402
```

### Contracts (we deploy none; these are the ones the app calls on Robinhood Chain mainnet)
```text
$WIF  0x5173b8ea6923c2d40267890d45c46a3480954773
USDG  0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```

### Transactions (Robinhood Chain mainnet; the judges' check wants at least one that moves $WIF)
```text
USDG settlement via the x402 facilitator (0.05 USDG, the holder price: the payer holds $WIF): https://robinhoodchain.blockscout.com/tx/0x432e381183277e5f6b485adb0e4ff2cb072b59b38c80246c1b21efa99c446f33
$WIF cashback to the payer (10 $WIF): https://robinhoodchain.blockscout.com/tx/0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640
```

### Wallets (public addresses only)
```text
Payer: 0x6Ce9DA69A46842DCe90e6a14382Ed06eb1c46af5
Merchant / pay-to (sends the $WIF cashback): 0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6
```

## 6. Review

- [x] Every `[PLACEHOLDER]` replaced (search for `[`).
- [x] The two mainnet transactions are real and open on https://robinhoodchain.blockscout.com.
- [x] The live link answers `402` on `POST /api/ask` and the page loads.
- [x] Repo public since 2026-11-02: https://github.com/0xultravioleta/worldisflat-x402
- [x] Terms box read and ticked by Saúl; then **submit** (not only save), and screenshot the confirmation.
- [ ] Optional, after submitting: an update ("dispatch") with the video, and a post from Saúl's account.
- [x] The hire's five transactions (7 Nov 2026) succeeded on Robinhood Chain mainnet, and every Robinhood Chain hash
  and amount in the edit above is the one `npm run e2e:hire` printed
  ([docs/evidence/e2e-hire-2026-11-07.txt](docs/evidence/e2e-hire-2026-11-07.txt), checked by `test/docs.test.ts`). The
  merchant's identity (agent 1170265 and its two Base transactions) is not in that output: it comes from Execution
  Market's public record (`GET /api/v1/reputation/register/wallet/<merchant>?network=base`) and Base itself.
- [ ] The edit above pasted into the form, then the form read back, before 12 Nov 2026, 17:30 UTC.

## Long story (if a long field exists) · Devpost-style

```markdown
## Inspiration
Agents can answer questions and people can run errands, but there is no simple way to sell either one call at a time to anyone with a wallet. Robinhood Chain brings stablecoins to a mainstream audience, so we built the smallest useful storefront for it.

## What it does
An HTTP endpoint answers 402 Payment Required with a price in USDG on Robinhood Chain. A wallet or an agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles it on chain, and the endpoint answers the question or puts the task on a board for a human. Paid calls send $WIF back, up to a daily budget; $WIF holders who name their wallet pay half; humans who complete tasks earn $WIF.

## How we built it
A small TypeScript server (Hono) using the public uvd-x402-sdk on both sides, a landing page with a browser-wallet payment flow, and the Ultravioleta x402 facilitator, which already supports Robinhood Chain mainnet and testnet (its /supported lists both). $WIF is read and transferred directly on chain. A local fork of Robinhood Chain with the real USDG and $WIF contracts runs the whole flow as 22 automated checks.

## Challenges we ran into
USDG's on-chain version() reverts, so the EIP-712 domain has to travel in the 402 itself; and pricing the $WIF cashback so it rewards users without being farmable (10 $WIF is about 12% of a call).

## Accomplishments that we're proud of
One paid question to our live demo produced a real USDG settlement (https://robinhoodchain.blockscout.com/tx/0x432e381183277e5f6b485adb0e4ff2cb072b59b38c80246c1b21efa99c446f33) and a real $WIF cashback (https://robinhoodchain.blockscout.com/tx/0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640) on Robinhood Chain mainnet, with no custom chain code. The payer held $WIF (funded by the team), so it paid the holder price, 0.05 USDG instead of 0.10, and still got its 10 $WIF back: the flywheel, on chain.

## What we learned
x402 makes any API a Robinhood Chain storefront in a few lines, and a token flywheel fits naturally on top of a stablecoin price.

## What's next for Flat Fee
Escrowed human tasks through Execution Market, paying humans in USDG as well as $WIF, an LLM behind the agent, and subscriptions priced in $WIF.
```

## Tech / tags
```text
robinhood-chain, usdg, wif, x402, eip-3009, typescript, hono
```
