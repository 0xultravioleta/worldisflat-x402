# Ask & Hire on Robinhood Chain

> Pay-per-call AI agents and hire-a-human tasks priced in USDG on Robinhood Chain, settled over x402 by an open-source facilitator.

**Built for World Is Flat (Robinhood Chain).** Demo video: [VIDEO_URL] · Live demo: [DEMO_URL]

## What it does
An HTTP endpoint answers 402 Payment Required with a USDG price. Any wallet or agent pays with a signed authorization, our facilitator verifies and settles on Robinhood Chain, and the endpoint returns the answer, or opens an Execution Market task for a human.

## Why
Robinhood Chain brings stablecoins to a mainstream retail audience. We wanted the simplest useful thing an agent can sell there: an answer, or a person who goes and checks something, for a few cents of USDG.

## How it works
Ultravioleta's Rust x402 facilitator already supports Robinhood Chain mainnet and testnet with USDG (docs/ROBINHOOD_CHAIN.md). The demo is a small TypeScript server using the x402 SDK, plus a landing page.

```
requester / agent ──▶ task + budget ──▶ worker claims ──▶ evidence ──▶ AI verification ──▶ payout ──▶ reputation
```

## How we use Robinhood Chain + USDG
[Replace with the exact files, endpoints and calls. Judges look for this section. Example: `src/rails/...` calls ..., see screenshot docs/sponsor-usage.png.]

## Try it (judges: under 5 minutes)
1. `git clone https://github.com/0xultravioleta/worldisflat-x402 && cd [REPO]`
2. `cp .env.example .env` and fill the test values listed in `.env.example` (no real keys in the repo).
3. `npm install && npm run dev` (or `docker compose up`).
4. Open http://localhost:3000 → do **[STEP]** → see **[RESULT]**.
5. Hosted demo: [DEMO_URL] (test login in the submission's testing instructions, never in the repo).

## Built during the hackathon
Everything in this repo was written during the submission period unless listed here. Pre-existing services used only through their public APIs: Execution Market, PayBox, Ultravioleta x402 facilitator (https://github.com/UltravioletaDAO/x402-rs), ERC-8004 contracts. Commit range: [FIRST_COMMIT]…[LAST_COMMIT].

## Challenges and what we learned
Keeping the demo small enough to ship in a day while still settling real mainnet USDG. x402 makes any API a Robinhood Chain storefront in a few lines.

## What's next
Add Execution Market human tasks priced in USDG, and agent subscriptions.

## Team
Ultravioleta DAO: Saúl ([@0xultravioleta](https://x.com/0xultravioleta)) and c0der.

## License
MIT (see LICENSE). Must be visible in the GitHub About panel.
