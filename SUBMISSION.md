# SUBMISSION: Flat Fee (world is flat hackathon)

- **Submit at:** https://worldisflat.fun/build → sign in → start a team → submission (Luis does every click; nobody else
  registers, saves or submits).
- **Submissions close:** Mon 2 Nov 2026, 12:30 PM EST (17:30 UTC), per `worldisflat.fun/build/api/event`. Edits lock then;
  only the logo can change until the final (Fri 6 Nov 2026, 12:30 PM EST).
- **The project must stay live and working until Fri 6 Nov 2026, 12:30 PM EST**: judges try it.
- The form's steps, from the site's own copy: your team → your project → how it connects to $wif → your flywheel →
  proof of build → review. The site shows no character limits publicly; lengths are given so you can trim if a field asks.
- Replace every `[PLACEHOLDER]` first. Rules that shaped this: the name cannot use Robinhood's name or logo; the project
  must use $wif on chain on Robinhood Chain and have a flywheel; proof = a repo the judges can see, a demo video and real
  transactions.

## 1. Your team

```text
Team: Ultravioleta DAO
Lead (prize wallet): Luis ([LUIS_FULL_NAME], @[LUIS_X_HANDLE]), wallet [LUIS_WALLET_PUBLIC_ADDRESS]
Members: add c0der ([C0DER_NAME]) only if Luis decides. Up to 4 people; each person can be on one team only.
```

## 2. Your project

### Name · 8 chars
```text
Flat Fee
```

### One liner · 99 chars
```text
Ask an agent or hire a human for a flat USDG fee, paid over x402 on Robinhood Chain, with $WIF back
```

### Categories (the first one is the main one)
```text
agents and ai, consumer and payments, tools and infra
```

### What it does · 561 chars
```text
Flat Fee turns an HTTP endpoint into a storefront on Robinhood Chain. Ask the agent a question (live chain data: balances, blocks, gas, $WIF) or hire a human for a small task. The endpoint answers 402 Payment Required with a price in USDG; your wallet or agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles the USDG on chain, and the answer comes back. Every paid call sends $WIF back to the payer, $WIF holders pay half, and the humans who complete tasks are paid in $WIF. No accounts, no API keys, no gas for the buyer.
```

### Who it's for · 247 chars
```text
AI agents and people who want to buy one answer or one errand at a time, for cents, with any wallet; and builders who want any API to charge in USDG on Robinhood Chain without accounts or API keys. Humans nearby earn $WIF by completing paid tasks.
```

## 3. How it connects to $wif · 501 chars
```text
$WIF (0x5173b8ea6923c2d40267890d45c46a3480954773) is in every paid call, on chain on Robinhood Chain. 1) Cashback: after each USDG settlement, the merchant wallet transfers 10 $WIF to the payer. 2) Holder price: when you pay, the app reads your $WIF balance on chain; with 100 $WIF or more a question costs 0.05 USDG instead of 0.10. 3) Workers: a human who completes a hire task receives 50 $WIF. The holder price is read from the address that signed the payment, so it cannot be faked with a header.
```

## 4. Your flywheel

### What someone does · 85 chars
```text
Pays a flat USDG fee to ask the agent a question or to hire a human for a small task.
```

### What happens to $wif · 137 chars
```text
The merchant sends 10 $WIF back to the payer on Robinhood Chain after every settled call, and 50 $WIF to each human who completes a task.
```

### Why they come back · 172 chars
```text
Ten paid calls make you a $WIF holder, and holders pay half on every call after that. Workers come back for more tasks paid in $WIF, which also buys them the cheaper price.
```

## 5. Proof of build

### Links
```text
Live product: [DEMO_URL]
Demo video: [VIDEO_URL]
Repo: [REPO_URL]  (private is allowed if you invite the GitHub account wifonrh; c0der sends the invite)
```

### Contracts (we deploy none; these are the ones the app calls on Robinhood Chain mainnet)
```text
$WIF  0x5173b8ea6923c2d40267890d45c46a3480954773
USDG  0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
```

### Transactions (Robinhood Chain mainnet; the judges' check wants at least one that moves $WIF)
```text
USDG settlement via the x402 facilitator (0.10 USDG): [EXPLORER_TX_URL]
$WIF cashback to the payer (10 $WIF): [WIF_TX_URL]
```

### Wallets (public addresses only)
```text
Payer: 0x6Ce9DA69A46842DCe90e6a14382Ed06eb1c46af5
Merchant / pay-to (sends the $WIF cashback): 0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6
```

## 6. Review

- [ ] Every `[PLACEHOLDER]` replaced (search for `[`).
- [ ] The two mainnet transactions are real and open on https://robinhoodchain.blockscout.com.
- [ ] The live link answers `402` on `POST /api/ask` and the page loads.
- [ ] Repo public, or `wifonrh` invited and accepted.
- [ ] Terms box read and ticked by Luis; then **submit** (not only save), and screenshot the confirmation.
- [ ] Optional, after submitting: an update ("dispatch") with the video, and a post from Luis's account.

## Long story (if a long field exists) · Devpost-style

```markdown
## Inspiration
Agents can answer questions and people can run errands, but there is no simple way to sell either one call at a time to anyone with a wallet. Robinhood Chain brings stablecoins to a mainstream audience, so we built the smallest useful storefront for it.

## What it does
An HTTP endpoint answers 402 Payment Required with a price in USDG on Robinhood Chain. A wallet or an agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles it on chain, and the endpoint answers the question or puts the task on a board for a human. Every paid call sends $WIF back; $WIF holders pay half; humans who complete tasks earn $WIF.

## How we built it
A small TypeScript server (Hono) using the public uvd-x402-sdk on both sides, a landing page with a browser-wallet payment flow, and the Ultravioleta x402 facilitator, which already settled USDG on Robinhood Chain mainnet and testnet. $WIF is read and transferred directly on chain. A local fork of Robinhood Chain with the real USDG and $WIF contracts runs the whole flow as 21 automated checks.

## Challenges we ran into
USDG's on-chain version() reverts, so the EIP-712 domain has to travel in the 402 itself; and pricing the $WIF cashback so it rewards users without being farmable (10 $WIF is about 12% of a call).

## Accomplishments that we're proud of
A real USDG settlement and a real $WIF transfer on Robinhood Chain mainnet from one paid call, with no custom chain code.

## What we learned
x402 makes any API a Robinhood Chain storefront in a few lines, and a token flywheel fits naturally on top of a stablecoin price.

## What's next for Flat Fee
Escrowed human tasks through Execution Market, paying humans in USDG as well as $WIF, an LLM behind the agent, and subscriptions priced in $WIF.
```

## Tech / tags
```text
robinhood-chain, usdg, wif, x402, eip-3009, typescript, hono
```
