# SUBMISSION: Flat Fee (world is flat hackathon)

> **SUBMITTED 2 Nov 2026, 16:55 UTC** by Saúl on worldisflat.fun (team UltravioletaDAO, status "submitted"). Edits stay open until 12 Nov 2026, 17:30 UTC via "edit submission". Integration type ticked: *holding $wif unlocks something* + *other*; contract addresses left empty (we deploy none); "ok with wif featuring" ticked. **The edit to paste is [Form fields](#form-fields-worldisflatfun-edit-submission) below: one block per field of the form, in its order.**

- **Submit at:** https://worldisflat.fun/build → sign in → edit submission (Saúl does every click; nobody else
  registers, saves or submits).
- **Submissions close:** Thu 12 Nov 2026, 17:30 UTC (extended from 2 Nov; round one 12-14 Nov, final 14-16 Nov). Edits lock then;
  only the logo can change until the final (14-16 Nov 2026).
- **The project must stay live and working through the final (14-16 Nov 2026)**: judges try it.
- The form's steps, from the site's own copy: your team → your project → how it connects to $wif → your flywheel →
  proof of build → review. The form's script caps every text field; each block below gives its length and its field's
  cap.
- Rules that shaped this: the name cannot use Robinhood's name or logo; the project must use $wif on chain on Robinhood
  Chain and have a flywheel; proof = a repo the judges can see, a demo video and real transactions.

## Form fields (worldisflat.fun, edit submission)

The form's fields in its order, as its own script defines them
(https://worldisflat.fun/build/assets/js/form.js?v=0d65455f4eb5, read on 8 Nov 2026): one block per field, with its
length and the field's cap, all within it. The form opens filled with the answers of 2 Nov, and its maxlength cuts
without a word whatever does not fit: in every field, select all (Cmd+A) and paste the block over it; in *transactions*,
delete every item that is there first. The blocks are plain text for plain text boxes: no markdown, links as bare URLs,
one line each, ASCII only, so any way of counting gives the length written. *transactions* is a list, which the form
splits at spaces and commas: it gets transaction hashes only, one per line. The fields that are a choice say what to
pick.

They cite the first hire through Execution Market on mainnet, 7 Nov 2026 (task
3175424d-4f83-45cc-b871-92d9dcd3ffe3; [README, *A hire through Execution
Market*](README.md#a-hire-through-execution-market-7-nov-2026)). The worker in this run is a test wallet of the team,
driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person
and not a real customer. *how it's made* tells the run with that sentence. *transactions* lists the three Robinhood Chain
transactions that move $WIF: the cashback of the paid question of 2 Nov, then the hire's cashback and reward. Saúl pastes them; nothing here was sent.

### your team

Nothing to paste: this step stays as Saúl filled it on 2 Nov (the team name, UltravioletaDAO, and the lead's own
fields). The team step has no full-name field; the prize wallet goes only in payout_address, typed by the owner in the form. It is never written here: this file is public.
The team is Saúl (@0xultravioleta), the lead, and c0der, added as a member only if Saúl decides (up to 4 people, each on
one team only).

### project name · `name` · 8 of 60 chars

```text
Flat Fee
```

The logo, the form's next slot, is already uploaded (`docs/video/logo.png`, square, 1024×1024).

### one liner · `one_liner` · 75 of 80 chars

```text
Ask an agent or hire a human via Execution Market, flat USDG fee, $WIF back
```

### category · `category_slugs` · a choice

Keep the three of 2 Nov, the first one the main one: agents and ai, consumer and payments, tools and infra.

### what it does · `what_it_does` · 1411 of 1500 chars

```text
Flat Fee sells two things on Robinhood Chain, one call at a time: an answer from an agent that reads live chain data (balances, blocks, gas, $WIF), or a human hired through Execution Market for a small task answered in text. Its HTTP endpoint answers 402 Payment Required with a price in USDG. A wallet or an agent signs one EIP-3009 authorization, Ultravioleta's open-source x402 facilitator settles it on chain, and the endpoint answers the question, or hires a human through Execution Market: Flat Fee publishes the task there, its wallet locks the worker's pay in a USDG escrow on Robinhood Chain, and Flat Fee approves the text answer on its own, which releases the escrow to the worker. Paid calls send $WIF back, up to a daily budget; $WIF holders who name their wallet pay half; workers whose answer Flat Fee approves earn 50 $WIF on top. No accounts, no API keys, no gas for the buyer. The USDG payments and the escrow's lock and release are Robinhood Chain transactions too, with their hashes in the repo's README. Before anyone pays for a hire, the server says what happens if nobody takes it: "The task is on Execution Market, for any of its people to take. If no one takes it within 24 h, it expires there, with nothing locked for it. If the person who takes it does not deliver by then, Execution Market returns the escrowed pay to Flat Fee's wallet. Either way, the fee you paid is not refunded."
```

### who it's for · `who_its_for` · 483 of 500 chars

```text
AI agents and people who want to buy one answer, or one small task answered in text, at a time, for cents of USDG, with any wallet and no account or API key; $WIF holders, who pay half. People on Execution Market who take a Flat Fee task: the merchant locks their pay in a USDG escrow when they are assigned, and they get 50 $WIF on top when Flat Fee approves the answer. And builders who want their own API to charge USDG on Robinhood Chain over x402: the code is open source (MIT).
```

### how does it use $wif · `wif_usage` · 750 of 1000 chars

```text
$WIF (0x5173b8ea6923c2d40267890d45c46a3480954773) is on chain on Robinhood Chain in the paid calls. 1) Cashback: after a USDG settlement, the merchant wallet transfers 10 $WIF to the payer, up to 500 $WIF a day. 2) Holder price: a buyer that names its wallet before paying (the landing page does) is quoted from its $WIF balance on chain; with 100 $WIF or more a question costs 0.05 USDG instead of 0.10, and a hire 0.25 instead of 0.50. The price is then checked against the address that signed the payment, so a header cannot fake it. 3) Workers: a human hired through Execution Market whose answer Flat Fee approves is paid by the USDG escrow and receives 50 $WIF on top. The 500 $WIF a day is one budget for the cashback and the rewards together.
```

### integration type · `integration_types` · a choice

Keep the two of 2 Nov: holding $wif unlocks something, and other.

### contract addresses · `contract_addresses` · a list, optional

Leave it empty: the form wants it only for a product's own contracts on Robinhood Chain, and Flat Fee deploys none (it
calls USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` and $WIF `0x5173b8ea6923c2d40267890d45c46a3480954773`).

### ok to feature · `ok_to_feature` · a tick

Keep it ticked, as on 2 Nov.

### what does someone do · `flywheel_action` · 261 of 500 chars

```text
Pays a flat USDG fee, with one signature over x402, to ask the agent a question (0.10 USDG) or to hire a human through Execution Market for a small task answered in text (0.50 USDG); $WIF holders pay half. Or takes such a task on Execution Market as the worker.
```

### what happens to $wif when they do it · `flywheel_wif` · 278 of 500 chars

```text
The merchant sends the payer 10 $WIF after a settled call, up to 500 $WIF a day, and 50 $WIF to each Execution Market worker whose answer it approves. A payer holding 100 $WIF or more who names its wallet before paying pays half, checked on chain against the address that signs.
```

### why does that bring them, or others, back · `flywheel_return` · 193 of 500 chars

```text
Ten paid calls make you a $WIF holder, and holders pay half on every call after that. Execution Market workers return for tasks paid in USDG escrow plus $WIF, which buys them the cheaper price.
```

### github repo · `repo_url` · 50 of 300 chars

```text
https://github.com/0xultravioleta/worldisflat-x402
```

### demo video · `demo_video_url` · 28 of 300 chars

```text
https://youtu.be/oRGfZMNiinI
```

### live link · `live_url` · 35 of 300 chars

```text
https://flatfee.ultravioletadao.xyz
```

### transactions · `tx_hashes` · a list, one hash per line

```text
0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640
0xf4318a5ef5871332a7b029e66f3315cc161e1ffe03267c1ad04662546cad030a
0xde1aa451397d68bfa3a1e12ad0a57cadb60dc3c36a8d316bd5a7decbc37fade6
```

The three that move $WIF, on Robinhood Chain mainnet, as the README cites them: the $WIF cashback of the paid question of
2 Nov, then the hire of 7 Nov's $WIF cashback and its $WIF reward to the test worker. The field asks for transactions
where the product uses $wif, and the judges' panel marks each one "moves $wif" or "no $wif moved": the USDG payments and
the escrow's lock and release stay in the README's evidence, not here.

### how it's made · `how_its_made` · 1492 of 1500 chars

```text
Stack: a TypeScript server (Hono) with the public uvd-x402-sdk on both sides, a landing page for browser wallets, ethers for $WIF (balanceOf for the holder price, transfer to pay it out), and Ultravioleta's open-source x402 facilitator, which settles USDG and pays the gas. Hiring: Execution Market's REST API, signed by the merchant wallet (ERC-8128, ERC-8004 agent 1170265 on Base), and a USDG escrow built with the SDK. CI runs the unit tests offline, Execution Market as a double; a mainnet fork with the real USDG and $WIF runs paid calls and the task board. Hardest part: USDG's version() reverts, so the EIP-712 domain travels in the 402; and the merchant signs an escrow only once the contracts, chain and token Execution Market publishes match its own. On 7 Nov 2026 one hire from the live demo ran end to end on mainnet: the team's payer wallet paid 0.25 USDG, 0.20 USDG went into escrow, 0.174 USDG was released to the worker, plus 50 $WIF to the worker and 10 $WIF back to the buyer. The worker in this run is a test wallet of the team, driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person and not a real customer. Known limit: the demo approves on its own any text answer of up to 2000 bytes from the worker it assigned, so a buyer with a second wallet could swap USDG for $WIF; the server caps all the $WIF it sends at 500 $WIF a UTC day (WIF_DAILY_BUDGET, src/wif.ts), reset by a restart of the demo's container.
```

### what's next · `whats_next` · 196 of 500 chars

```text
Ratings of every Execution Market task written on Robinhood Chain (ERC-8004), once the SDK Execution Market runs on can relay them there; an LLM behind the agent; and subscriptions priced in $WIF.
```

## Review

- [ ] Saúl opens "edit submission", pastes each block above into its field in the form's order, picks or ticks the
  choice fields as written, and saves each step (the form also saves a step 2 s after typing stops).
- [ ] On the review step, every answer read back against this section: *transactions* as the three hashes and nothing
  else, *how it's made* with the sentence about the test worker. Before 12 Nov 2026, 17:30 UTC.
- [x] The three transactions are Robinhood Chain mainnet ones the README cites, the ones that move $WIF: the cashback of
  the paid question of 2 Nov, and the hire of 7 Nov's cashback and reward, whose hashes and amounts are the ones
  `npm run e2e:hire` printed
  ([docs/evidence/e2e-hire-2026-11-07.txt](docs/evidence/e2e-hire-2026-11-07.txt)). `test/docs.test.ts` checks every
  block against its field's cap, the hashes and amounts against the run, and the sentence about its worker. The
  merchant's identity (agent 1170265) is not in that output: it comes from Execution Market's public record
  (`GET /api/v1/reputation/register/wallet/<merchant>?network=base`) and Base itself.
- [ ] Optional: an update ("dispatch") on worldisflat.fun, and a post from Saúl's account.

## Earlier drafts (replaced: do not paste)

The texts drafted for the submission of 2 Nov and the edit drafted on 7 Nov were written before the form's fields were
known. The edit had ten blocks: three for fields the form does not have (*Wallets*, a long *What it does*,
*Accomplishments*) and *Transactions* as prose with links, where the form takes a list of hashes. *Form fields* above
replaces both; they stay in this file's history (`SUBMISSION.md` at `d4bb668`). Until the edit is pasted, the form shows
the answers of 2 Nov; the one liner the site showed on 8 Nov 2026 is "Ask an agent or hire a human for a flat USDG fee on
Robinhood Chain, $WIF back".
