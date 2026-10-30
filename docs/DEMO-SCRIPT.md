# Demo video: Flat Fee (60-90 s)

Shot list for the screen recording that matches the app as built. Grok Bot polishes the words, Luis does the voice.
Record 1080p, browser at http://localhost:3000 (or the live URL) on the left, a terminal on the right.

## Before recording

- [ ] `npm run reset` (empty ledger and board), then `npm start` with the mainnet `.env` (or `npm run demo` for a rehearsal:
      same screens on a local fork, links do not resolve).
- [ ] Never connect a real wallet to `npm run demo`: the fork has mainnet's chain id, so a signature made there is a valid
      mainnet authorization. The demo page turns its **Pay … with wallet** buttons off; only the demo's throwaway wallet
      signs, and it has already paid one question and one hire task.
- [ ] Payer wallet funded with the approved USDG; merchant wallet holds the $WIF cashback budget and a little ETH.
- [ ] Terminal font large; no `.env`, keys or seed phrases anywhere on screen. `npm run balances` shows addresses only.
- [ ] Explorer tab ready: https://robinhoodchain.blockscout.com

## Shots

| time | on screen | voice-over (draft) |
|---|---|---|
| 0:00-0:08 | landing page hero, "Flat Fee" | Flat Fee: ask an agent or hire a human, for a flat fee in USDG on Robinhood Chain. |
| 0:08-0:20 | type a question, click **See the 402** | The endpoint answers 402 Payment Required with a price: ten cents of USDG, on Robinhood Chain. |
| 0:20-0:40 | terminal: `npm run buy -- "What does 0x5173b8ea6923c2d40267890d45c46a3480954773 hold?"` (mainnet needs `CONFIRM_MAINNET_SPEND=0.10` and `PAY_TO` = the merchant wallet in `.env`) | An agent pays it with one signature. No gas, no approve: our open-source x402 facilitator settles the USDG on chain. |
| 0:40-0:52 | the JSON answer and receipt in the terminal; the new row under **Paid calls** | The answer comes back with the settlement, and 10 $WIF goes back to the payer. |
| 0:52-1:02 | click the settlement link and the $WIF link on the explorer | Both are real transactions on Robinhood Chain mainnet. |
| 1:02-1:15 | The **Task board**: claim and complete a paid task. On mainnet, paying for a new task with the wallet is a second settle (0.50 USDG) plus a 50 $WIF reward, and needs its own OK. Without that OK, record this shot on `npm run demo` with the task the demo already paid for: paste the worker token `demo`, enter any address, **claim**, type an answer, **complete**. Do not pay anything on the demo, and say on screen that it is a local rehearsal | Hire a human the same way. Whoever completes the task earns $WIF. |
| 1:15-1:25 | the flywheel table from the README | Pay in USDG, get $WIF back; hold 100 $WIF and your calls cost half. |
| 1:25-1:30 | end card: Flat Fee, repo, live URL | Flat Fee. Links below. |

## Numbers on screen must be real

The settlement and cashback hashes in the video must be the ones in README "Real transactions". Do not show the fork
rehearsal's hashes as mainnet ones.
