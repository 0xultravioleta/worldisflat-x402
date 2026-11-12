# SUBMISSION: Flat Fee (world is flat hackathon)

> **SUBMITTED 2 Nov 2026, 16:55 UTC** by Saúl on worldisflat.fun (team UltravioletaDAO, status "submitted"). Edits stay open until 12 Nov 2026, 17:30 UTC via "edit submission". Integration type ticked: *holding $wif unlocks something* + *other*; contract addresses left empty (we deploy none); "ok with wif featuring" ticked. **The edit of 12 Nov 2026 rewrites every text field: the plan is [What changes and where](#what-changes-and-where-edit-of-12-nov-2026), and the edit to paste is [Form fields](#form-fields-worldisflatfun-edit-submission) below: one block per field of the form, in its order.**

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

## What changes and where (edit of 12 Nov 2026)

What the form holds today is what was pasted on 2 Nov: the site shows the name, the one liner and the categories to
anyone (https://worldisflat.fun/build/api/projects/flat-fee, read on 12 Nov 2026); the other fields sit behind the
owner's login, and their 2 Nov text is this file at `45fab02` (`git show 45fab02:SUBMISSION.md`). The story changed
since then: on 2 Nov a hire went to a task board on Flat Fee itself; since 7 Nov the live demo hires through Execution
Market on Robinhood Chain, with the worker's pay in USDG escrow and Flat Fee as an ERC-8004 agent, and KarmaKadabra, the
team's swarm of AI agents, has used the same market on Robinhood Chain. Every text field is rewritten for that; the
$WIF use and the flywheel, the fields that score, stay the center.

| field | published (2 Nov) | this edit (12 Nov) | why |
|---|---|---|---|
| project name `name` | Flat Fee | Flat Fee | no change |
| one liner `one_liner` | "Ask an agent or hire a human for a flat USDG fee on Robinhood Chain, $WIF back" | "Ask an agent or hire a human via Execution Market for a flat USDG fee, $WIF back" | hiring goes through Execution Market now |
| category `category_slugs` | agents and ai, consumer and payments, tools and infra | the same three | no change |
| what it does `what_it_does` | a storefront: a 402 in USDG, one signature, the answer; tasks for a human; $WIF back, holders pay half, humans paid in $WIF | the same storefront, plus the hire as it runs: published on Execution Market by an ERC-8004 agent, the pay in USDG escrow on Robinhood Chain, the approval; the swarm's tasks on that market; the server's own words for a hire nobody takes | the 2 Nov text describes the task board, which the live demo no longer uses (`EM_HIRE` on since 7 Nov); the $WIF loop keeps its daily cap and the wallet the buyer names |
| who it's for `who_its_for` | agents and people buying one answer or errand; builders; "Humans nearby earn $WIF by completing paid tasks." | Execution Market's people, whose pay is locked in escrow when they are assigned, plus 50 $WIF for an approved answer | the workers come from Execution Market now |
| how does it use $wif `wif_usage` | cashback; the holder price of a question; 50 $WIF to a worker | adds the holder price of a hire, the worker paid by the escrow with $WIF on top, one daily budget, and the six $WIF transfers on chain and whose wallets got them | the field asks for specifics; all of it is on chain |
| integration type `integration_types` | holding $wif unlocks something, other | the same two | no change (the options load only after login) |
| contract addresses `contract_addresses` | empty | empty | Flat Fee deploys no contract |
| ok to feature `ok_to_feature` | ticked | ticked | no change |
| what does someone do `flywheel_action` | "Pays a flat USDG fee to ask the agent a question or to hire a human for a small task." | the prices, the holder half, and the worker's side: a Flat Fee task on Execution Market, its pay in escrow before the work starts | the loop's second person, the worker, was missing |
| what happens to $wif `flywheel_wif` | 10 $WIF back after a call, 500 a day, 50 to each human who completes a task | the 50 only for an answer Flat Fee approves, on top of the escrow; the holder half checked on chain against the signer | as the code does it |
| why they come back `flywheel_return` | ten paid calls make a holder; workers paid in $WIF | adds the worker's pay locked in escrow before the work starts, and the $WIF that buys workers the cheaper price | why each side comes back, with $WIF |
| github repo `repo_url` | https://github.com/0xultravioleta/worldisflat-x402 | the same | no change |
| demo video `demo_video_url` | https://youtu.be/oRGfZMNiinI | `<<VIDEO_V2>>`: the new video's link, once the owner uploads it | the 2 Nov video shows none of Execution Market, the swarm or ERC-8004 |
| live link `live_url` | https://flatfee.ultravioletadao.xyz | the same | no change |
| transactions `tx_hashes` | the 2 Nov draft was prose with two explorer links | the six $WIF transfers the merchant has made on mainnet, hashes only | the field asks for transactions where the product uses $wif, and splits at spaces and commas |
| how it's made `how_its_made` | how it was built and its challenges (22 fork checks; USDG's `version()`; pricing the cashback) | the stack, Execution Market and the escrow, the two ERC-8004 identities, the hardest part, the two hires on mainnet with the sentence about their worker, the swarm's two tasks with their USDG amounts (agent to agent), and the known limit | the hire and the identities are what was built since; the swarm shows the market in use |
| what's next `whats_next` | "Escrowed human tasks through Execution Market, paying humans in USDG as well as $WIF, an LLM behind the agent, and subscriptions priced in $WIF." | ratings on Robinhood Chain, which Execution Market does not write yet; the swarm's agents as buyers; an LLM; $WIF subscriptions | the escrowed tasks are done; the ratings are what is left |

What every new claim stands on is in [What the new texts stand on](#what-the-new-texts-stand-on-read-12-nov-2026),
below the form.

## Form fields (worldisflat.fun, edit submission)

The form's fields in its order, as its own script defines them
(https://worldisflat.fun/build/assets/js/form.js?v=0d65455f4eb5, read on 8 Nov 2026, the same file on 12 Nov 2026): one
block per field, with its length and the field's cap, all within it. The form opens filled with the answers of 2 Nov,
and its maxlength cuts without a word whatever does not fit: in every field, select all (Cmd+A) and paste the block over
it; in *transactions*, delete every item that is there first. The blocks are plain text for plain text boxes: no
markdown, links as bare URLs, one line each, ASCII only, so any way of counting gives the length written. *transactions*
is a list, which the form splits at spaces and commas: it gets transaction hashes only, one per line. The fields that
are a choice say what to pick.

They cite the first hire through Execution Market on mainnet, 7 Nov 2026 (task
3175424d-4f83-45cc-b871-92d9dcd3ffe3; [README, *A hire through Execution
Market*](README.md#a-hire-through-execution-market-7-nov-2026)). The worker in this run is a test wallet of the team,
driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person and
not a real customer. The second hire, on 8 Nov 2026, had the same worker and the same buyer. *how it's made* tells the
runs with that sentence. *transactions* lists the six Robinhood Chain transactions that move $WIF: every $WIF transfer
the merchant has made on mainnet, the cashback of four paid calls and the reward of the two hires. Saúl pastes them;
nothing here was sent.

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

### one liner · `one_liner` · 80 of 80 chars

```text
Ask an agent or hire a human via Execution Market for a flat USDG fee, $WIF back
```

### category · `category_slugs` · a choice

Keep the three of 2 Nov, the first one the main one: agents and ai, consumer and payments, tools and infra.

### what it does · `what_it_does` · 1461 of 1500 chars

```text
Flat Fee is a pay-per-call storefront on Robinhood Chain with $WIF in the loop. Its HTTP endpoint answers 402 Payment Required with a flat price in USDG; a wallet or an agent signs one EIP-3009 authorization, and Ultravioleta's open-source x402 facilitator settles it on chain and pays the gas. For 0.10 USDG an agent answers from live chain data (balances, blocks, gas, $WIF). For 0.50 USDG Flat Fee hires a human through Execution Market on Robinhood Chain: it publishes the task there as an ERC-8004 agent, locks the worker's pay in a USDG escrow on Robinhood Chain, approves the text answer, and the escrow pays the worker. Settled calls send 10 $WIF back to the payer, up to 500 $WIF a day; $WIF holders who name their wallet pay half; and each worker whose answer Flat Fee approves earns 50 $WIF on top. That market is not only Flat Fee's on Robinhood Chain: on 11 and 12 Nov 2026 two agents of KarmaKadabra, our swarm of AI agents, hired two others there, and both tasks were paid out of USDG escrow on Robinhood Chain. No accounts, no API keys, no gas for the buyer. Before anyone pays for a hire, the server says what happens if nobody takes it: "The task is on Execution Market, for any of its people to take. If no one takes it within 24 h, it expires there, with nothing locked for it. If the person who takes it does not deliver by then, Execution Market returns the escrowed pay to Flat Fee's wallet. Either way, the fee you paid is not refunded."
```

### who it's for · `who_its_for` · 455 of 500 chars

```text
AI agents and people who want one answer, or one small task answered in text, for cents of USDG, with any wallet and no account or API key; $WIF holders, who pay half. People on Execution Market who take a Flat Fee task: their pay is locked in USDG escrow on Robinhood Chain when they are assigned, and an approved answer earns 50 $WIF on top. And builders who want their own API to charge USDG on Robinhood Chain over x402: the code is open source (MIT).
```

### how does it use $wif · `wif_usage` · 968 of 1000 chars

```text
$WIF (0x5173b8ea6923c2d40267890d45c46a3480954773) moves on Robinhood Chain in the paid calls. 1) Cashback: after a USDG settlement the merchant wallet transfers 10 $WIF to the payer, up to 500 $WIF a day. 2) Holder price: a buyer that names its wallet before paying (the landing page does) is quoted from its $WIF balance on chain; with 100 $WIF or more a question costs 0.05 USDG instead of 0.10, and a hire 0.25 instead of 0.50. The price is then checked against the address that signed the payment, so a header cannot fake it. 3) Workers: a human hired through Execution Market is paid in USDG by the escrow, and receives 50 $WIF on top when Flat Fee approves the answer. The 500 $WIF a day is one budget for the cashback and the rewards together. So $WIF is the buyer's discount key and the worker's bonus. The six $WIF transfers the merchant made on mainnet up to 12 Nov 2026, cashback and rewards, are all in transactions; every one went to a wallet of the team.
```

### integration type · `integration_types` · a choice

Keep the two of 2 Nov: holding $wif unlocks something, and other.

### contract addresses · `contract_addresses` · a list, optional

Leave it empty: the form wants it only for a product's own contracts on Robinhood Chain, and Flat Fee deploys none (it
calls USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` and $WIF `0x5173b8ea6923c2d40267890d45c46a3480954773`).

### ok to feature · `ok_to_feature` · a tick

Keep it ticked, as on 2 Nov.

### what does someone do · `flywheel_action` · 372 of 500 chars

```text
Pays a flat USDG fee with one x402 signature: 0.10 USDG to ask the agent a question, 0.50 USDG to hire a human through Execution Market for a small task answered in text; $WIF holders pay half. Or takes such a task on Execution Market as the worker: the pay is locked in USDG escrow on Robinhood Chain before the work starts and released when Flat Fee approves the answer.
```

### what happens to $wif when they do it · `flywheel_wif` · 327 of 500 chars

```text
The merchant sends the payer 10 $WIF on Robinhood Chain after each settled call, up to 500 $WIF a day, and 50 $WIF to each Execution Market worker whose answer it approves, on top of the USDG escrow. A payer holding 100 $WIF or more who names its wallet before paying pays half, checked on chain against the address that signs.
```

### why does that bring them, or others, back · `flywheel_return` · 221 of 500 chars

```text
Ten paid calls make you a $WIF holder, and holders pay half on every call after that. Workers come back for tasks whose USDG is locked in escrow before they start, plus $WIF that buys them the cheaper price when they buy.
```

### github repo · `repo_url` · 50 of 300 chars

```text
https://github.com/0xultravioleta/worldisflat-x402
```

### demo video · `demo_video_url` · 12 of 300 chars

```text
<<VIDEO_V2>>
```

A marker, not a link: the new video (Execution Market, the swarm on Robinhood Chain and ERC-8004 on screen) is not
uploaded yet. c0der puts its link in this block, in the README's links line and in the paste kit once the owner uploads
it. Until then, do not paste the marker: leave the field with the video of 2 Nov, https://youtu.be/oRGfZMNiinI.

### live link · `live_url` · 35 of 300 chars

```text
https://flatfee.ultravioletadao.xyz
```

### transactions · `tx_hashes` · a list, one hash per line

```text
0xb0f3433c98ec074ce3dff3fb2d567dd2fe63d7ba291425dc6e36d81de181f640
0xf4318a5ef5871332a7b029e66f3315cc161e1ffe03267c1ad04662546cad030a
0xde1aa451397d68bfa3a1e12ad0a57cadb60dc3c36a8d316bd5a7decbc37fade6
0xc3c5d09e7f06e06ec1a0936ca928ffa72a28efbb2762c2b92841548ec4143367
0x19a3e6643cb0f0a6a01b3bccf11fabdae9fd7ce63ecb257fdcba08c1f58b01d6
0xe2086ab4a8d6ae2c8a4381d2aaa6acfbc5a8928d795b722876d89d17667a2a2f
```

The six that move $WIF, on Robinhood Chain mainnet, as the README cites them, oldest first: the $WIF cashback of the
paid question of 2 Nov; the hire of 7 Nov's $WIF cashback and its $WIF reward to the test worker; the $WIF cashback of a
paid question of 7 Nov; the hire of 8 Nov's $WIF cashback and its $WIF reward to the same test worker. They are every
$WIF transfer the merchant has made on mainnet (read on chain on 12 Nov 2026,
[docs/evidence/robinhood-2026-11-12.json](docs/evidence/robinhood-2026-11-12.json)). The field asks for transactions
where the product uses $wif, and the judges' panel marks each one "moves $wif" or "no $wif moved": the USDG payments,
the escrows and the swarm's four transactions (USDG, agent to agent, through Execution Market) stay in the README's
evidence, and the swarm's amounts in *how it's made*, not here.

### how it's made · `how_its_made` · 1496 of 1500 chars

```text
Stack: TypeScript (Hono), the public uvd-x402-sdk on both sides, ethers for $WIF (balanceOf, transfer) and Ultravioleta's open-source x402 facilitator, which settles USDG and pays the gas. Hiring: Execution Market's API signed with ERC-8128, and the SDK's USDG escrow. Identity: the merchant is ERC-8004 agent 22487 on Robinhood Chain and ERC-8004 agent 1170265 on Base. Hardest part: USDG's version() reverts, so the EIP-712 domain travels in the 402; and the merchant signs an escrow only once the contracts, chain and token Execution Market publishes match its own. On 7 Nov 2026 one hire ran end to end on mainnet: the team's payer wallet paid 0.25 USDG, 0.20 USDG went into escrow, 0.174 USDG was released to the worker, plus 50 $WIF to the worker and 10 $WIF back to the buyer (again on 8 Nov). The worker in this run is a test wallet of the team, driven by a script, that declares itself to Execution Market as a PayBox client (human_via_agent); it is not a person and not a real customer. Our KarmaKadabra agents hire each other on Execution Market too: in two tasks each buyer locked 0.01 USDG in escrow on Robinhood Chain and the agent that delivered got 0.0087 USDG, net of a 13% fee. Known limit: the demo approves on its own any text answer of up to 2000 bytes from the worker it assigned, so a buyer with a second wallet could swap USDG for $WIF; the server caps all the $WIF it sends at 500 $WIF a UTC day (WIF_DAILY_BUDGET, src/wif.ts), reset by a restart of the demo's container.
```

### what's next · `whats_next` · 421 of 500 chars

```text
Ratings: Flat Fee and the swarm's agents that hired on Robinhood Chain all hold ERC-8004 identities there, but Execution Market writes no ratings on Robinhood Chain yet. Next, Flat Fee rates every worker it approves, on Robinhood Chain once Execution Market can write there. Then KarmaKadabra's agents as Flat Fee buyers, paying USDG per answer and earning $WIF; an LLM behind the agent; and subscriptions priced in $WIF.
```

## What the new texts stand on (read 12 Nov 2026)

Every read is public and is kept, as read, in
[docs/evidence/robinhood-2026-11-12.json](docs/evidence/robinhood-2026-11-12.json); `test/docs.test.ts` checks the
texts above and the README against it.

- **Hiring through Execution Market on Robinhood Chain, live:** `GET https://flatfee.ultravioletadao.xyz/api/info`
  answers `hire.via: "execution-market"` and `hire.available: true`. The two hires on mainnet, both `completed` with the
  escrow `released` in Execution Market's records:
  https://api.execution.market/api/v1/tasks/3175424d-4f83-45cc-b871-92d9dcd3ffe3 (7 Nov) and
  https://api.execution.market/api/v1/tasks/d161b088-ae87-44df-8ed3-5af09018c779 (8 Nov); every transaction of both is
  in the README ([A hire through Execution Market](README.md#a-hire-through-execution-market-7-nov-2026), whose worker
  is a team test wallet driven by a script, not a person, and [Two more paid calls from the
  team](README.md#two-more-paid-calls-from-the-team-7-and-8-nov-2026)).
- **The swarm on the same market:** two tasks KarmaKadabra's agents published on Execution Market, paid in USDG on
  Robinhood Chain, taken by two other agents of the swarm and approved by their buyers on 12 Nov 2026:
  https://execution.market/tasks/3f8c7506-4069-4ee5-9306-de63b8224aec and
  https://execution.market/tasks/c03d5028-ff09-427e-b780-1329e8075bb8. The lock and the payment of each, with their
  amounts, are in the README ([The same market, used by our agent
  swarm](README.md#the-same-market-used-by-our-agent-swarm-11-12-nov-2026)); the agents are in the swarm's public
  graph, https://karmakadabra.ultravioletadao.xyz/graph.json. Flat Fee is not a party to these tasks.
- **ERC-8004 on Robinhood Chain:** Flat Fee's merchant is agent 22487 in the ERC-8004 identity registry on Robinhood
  Chain (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`): Ultravioleta's facilitator minted it and transferred it to the
  merchant on 7 Nov 2026 at 18:47 UTC, seconds before Flat Fee published its first task there, and Execution Market's
  record gives the same agent:
  https://api.execution.market/api/v1/reputation/register/wallet/0xb9056196d3D00b4c09ec2E5E123E30b376d39cC6?network=robinhood.
  On Base it is agent 1170265, and the first task (7 Nov) still names that one as its publisher; the second (8 Nov) names
  22487. The test worker and the four agents of the swarm's two tasks hold identities on
  Robinhood Chain too (22488, 23394, 23395, 25419, 25420).
- **Ratings on Robinhood Chain:** none yet. No identity above has a rating there (its ERC-8004 reputation registry lists
  no rater for any of them), nor has Flat Fee's identity on Base, and Execution Market does not write ratings on Robinhood
  Chain today: its public list of networks marks robinhood as not selectable for ratings
  (https://api.execution.market/api/v1/reputation/networks). Hence *what's next*. The swarm's four agents do carry ratings
  from earlier tasks on Base, where Execution Market writes them today: their ERC-8004 identities there have 18, 26, 3
  and 1 raters (README).

## Review

- [ ] Saúl opens "edit submission", pastes each block above into its field in the form's order, picks or ticks the
  choice fields as written, and saves each step (the form also saves a step 2 s after typing stops).
- [ ] On the review step, every answer read back against this section: *transactions* as the six hashes and nothing
  else, *how it's made* with the sentence about the test worker, *demo video* with a real link (the new one, or the one
  of 2 Nov while the new one is not up). Before 12 Nov 2026, 17:30 UTC.
- [x] The six transactions are every $WIF transfer of the merchant on Robinhood Chain mainnet, read on chain on 12 Nov
  2026, each one on a README row with its amount and direction. The hire of 7 Nov's hashes and amounts are the ones
  `npm run e2e:hire` printed
  ([docs/evidence/e2e-hire-2026-11-07.txt](docs/evidence/e2e-hire-2026-11-07.txt)); the others are in
  [docs/evidence/robinhood-2026-11-12.json](docs/evidence/robinhood-2026-11-12.json). `test/docs.test.ts` checks every
  block against its field's cap, the hashes and amounts against both, and the sentence about the hires' worker. The
  merchant's identity on Base (agent 1170265) is not in the run's output: it comes from Execution Market's public record
  (`GET /api/v1/reputation/register/wallet/<merchant>?network=base`) and Base itself.
- [ ] Optional: an update ("dispatch") on worldisflat.fun, and a post from Saúl's account.

## Earlier drafts (replaced: do not paste)

The texts drafted for the submission of 2 Nov and the edit drafted on 7 Nov were written before the form's fields were
known; the edit of 8 Nov (`fb46623`) had the form's fields but told the story before the swarm and the identity on
Robinhood Chain, and was never pasted. *Form fields* above replaces all three; they stay in this file's history
(`SUBMISSION.md` at `45fab02`, `d4bb668` and `fb46623`). Until the edit is pasted, the form shows the answers of 2 Nov;
the one liner the site shows is "Ask an agent or hire a human for a flat USDG fee on Robinhood Chain, $WIF back".
