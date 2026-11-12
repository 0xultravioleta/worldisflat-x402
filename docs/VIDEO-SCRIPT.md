# Demo video: quick recording (browser only, about 2 minutes)

This is the version to record for the submission. It uses only the browser: no terminal, no wallet, no new payments.
Every hash on screen is real and already on Robinhood Chain mainnet. It replaces `DEMO-SCRIPT.md` and
`kit/video-script.md`, which describe an older terminal shot list.

- **Deadline:** submissions close **Thu 12 Nov 2026, 17:30 UTC** (extended from 2 Nov). We submit early anyway.
- **Published:** https://youtu.be/kdFZ6c3wrF4, for the submission edit of 12 Nov. This script produced the video of 2 Nov, https://youtu.be/oRGfZMNiinI (Unlisted; voice-over ElevenLabs. Logo, thumbnail, subtitles and the YouTube description are in [`video/`](video/)).
- **Record:** macOS Cmd+Shift+5 → "Record Entire Screen", microphone on (Options). 1080p is enough. One take is fine.
- **Before recording:** open the five tabs below in order, zoom the browser to 125% so the text reads on a phone, and
  close anything with keys, `.env`, emails or tokens. Do not connect a wallet.
- **Upload:** YouTube → Create → Upload video → visibility **Unlisted**. Title:
  `Flat Fee | x402 + USDG + $WIF on Robinhood Chain | The World is Flat hackathon`. Copy the `https://youtu.be/...` link.
- **Then:** paste the link in `SUBMISSION.md` (`[VIDEO_URL]`) and in the form, step 5 "Proof of build".

## Tabs

1. Demo: https://flatfee.ultravioletadao.xyz
2. Payment tx (0.05 USDG): https://robinhoodchain.blockscout.com/tx/0x432e381183277e5f6b485adb0e4ff2cb072b59b38c80246c1b21efa99c446f33
3. Cashback tx (10 $WIF): https://robinhoodchain.blockscout.com/tx/0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640
4. README, flywheel table: https://github.com/0xultravioleta/worldisflat-x402#the-wif-flywheel
5. Repo: https://github.com/0xultravioleta/worldisflat-x402

## Shots

| # | Time | On screen | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:15 | Tab 1, top of the page: "Flat Fee" and the lead paragraph | Flat Fee: ask an agent or hire a human for a flat USDG fee on Robinhood Chain, with $WIF back. No accounts, no API keys, no gas for the buyer. |
| 2 | 0:15–0:40 | Tab 1, "1 · Ask the agent": leave the sample question, click **See the 402**, let the JSON show `"network":"eip155:4663"`, the USDG asset and `"amount":"100000"` | Every call is plain HTTP. Ask a question and the endpoint answers 402 Payment Required, with a price in USDG on Robinhood Chain: ten cents. A wallet or an agent signs one EIP-3009 authorization, and that's the payment. If you hold 100 $WIF or more, you pay half: five cents. |
| 3 | 0:40–1:05 | Scroll to **Paid calls** (the row with tier holder, 0.05), click the settlement link → tab 2. Point at From/To, the 0.05 USDG transfer and "Success" | This is a real paid question to this live demo. The payer held $WIF, so it paid the holder price: 0.05 USDG. The transfer was settled on Robinhood Chain mainnet by Ultravioleta's open-source x402 facilitator, which paid the gas. |
| 4 | 1:05–1:25 | Back to Paid calls, click the **$WIF back** link → tab 3. Point at the 10 WIF token transfer from the merchant to the payer | Right after the payment settles, the merchant wallet sends 10 $WIF back to whoever paid. Also on chain, also real. The cashback has a daily budget and is worth far less than the fee, so it can't be farmed. |
| 5 | 1:25–1:45 | Tab 4, the flywheel table | That's the flywheel. You pay in USDG and get $WIF back. Ten paid calls make you a holder, and holders pay half on every call after that. Humans who complete hire tasks earn 50 $WIF, which also buys them the cheaper price. More holders, more use. |
| 6 | 1:45–2:00 | Tab 5, the repo top (README) | Flat Fee is open source and live now. The repo, the demo and both transactions are linked below. Built by Ultravioleta DAO. |

## Checklist

- [ ] Every tab opens before recording, and **See the 402** shows the JSON (the page needs no wallet for that).
- [ ] No keys, seeds, emails or tokens on screen; no wallet extension popups.
- [ ] Do not click **Pay … USDG with wallet**: it would spend real USDG on mainnet.
- [ ] Do not say "Robinhood" as if it were our brand: the name is Flat Fee, Robinhood Chain is only the network.
- [ ] Do not say the hire flow was paid on mainnet: only the question (0.05 USDG) and its cashback (10 $WIF) were.
