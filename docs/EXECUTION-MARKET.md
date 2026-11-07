# Hiring a human through Execution Market

Flat Fee sells "hire a human for a small task" for a flat USDG price over x402. With `EM_HIRE=on`, Flat Fee does not
keep its own task board for that: it acts as an **agent on [Execution Market](https://execution.market)**, publishes the
task there, locks the worker's pay in a USDG escrow on Robinhood Chain, approves the delivery, and adds the $WIF reward
on top. With `EM_HIRE` off (the default), everything works exactly as before: the task goes on Flat Fee's own board.

The switch exists because hiring through Execution Market needs all of it at once on Robinhood Chain: EM taking the
task and publishing its x402r escrow there, and `uvd-x402-sdk` able to build that escrow. EM's production
payment-config lists the Robinhood Chain escrow with USDG (recorded on 2026-11-06 in
`test/fixtures/em-payment-config.json`), and the SDK has Robinhood Chain (4663) rows from 2.114.0, the version pinned
here (2.106.0 had none, so every hire was refused). Robinhood Chain testnet (46630) has no escrow: EM's operator has no
code there and the SDK has no row for it. Whenever a check fails, a server with the knob on answers `503` to a hire
**before** the 402 (see below), so nobody pays for a task that cannot run. The knob stays off on the live demo until
it is turned on there.

## The flow

```
buyer ──x402 (USDG)──▶ Flat Fee ──publish (ERC-8128)──▶ Execution Market        Robinhood Chain
                          │                                  │
                          │◀── a human applies ──────────────┤
                          │── assign + X-Payment-Auth ──────▶│── locks the bounty (USDG escrow, merchant pays)
                          │                                  │◀── the human delivers a text answer
                          │── approve (or reject, with why) ▶│── releases the escrow to the human
                          │── 50 $WIF ──────────────────────────────────────────────▶ the human's payout address
buyer ◀── GET /api/tasks/:id (the answer) ──┘
```

1. **The buyer pays Flat Fee as today.** `POST /api/hire` answers 402 with the USDG price (0.50, or 0.25 for $WIF
   holders), the x402 facilitator settles it, and the buyer gets the $WIF cashback, all unchanged.
2. **Flat Fee publishes the task on Execution Market**, signed with ERC-8128 by the merchant wallet (EM's only
   production auth for agents; API keys are off). Body: the buyer's request as instructions, `bounty_usd` =
   `EM_BOUNTY_USDG`, `payment_network` = `NETWORK` (`robinhood` or `robinhood-testnet`), `payment_token` =
   `EM_PAYMENT_TOKEN` (USDG), `evidence_required: ["text_response"]`, `target_executor: "human"`,
   `deadline_hours` = `EM_DEADLINE_HOURS`. The `Idempotency-Key` is a UUID made with the task and kept with it, so a
   retried publish never creates a second task. Nothing is locked at publish (EM's escrow locks at assignment).
3. **A human applies; Flat Fee assigns and pays the escrow.** Flat Fee picks the applicant EM ranks first
   (`effective_reputation_score`, then the earliest), never one EM flagged (a review note on the application, or
   `recommended: false`), only one that applied as a person (directly or through an agent: EM's `human` and
   `human_via_agent`), never one whose escrow lock already failed,
   never the buyer's own wallet nor the merchant's. It builds the escrow authorization with the official builder,
   `buildEscrowPreAuth` from `uvd-x402-sdk`, signed by the merchant wallet, keeps it with the task (with the
   `paymentInfo` that releases or reclaims it), and sends it as `X-Payment-Auth` on `POST /api/v1/tasks/{id}/assign`. EM
   relays it to the facilitator, which locks the bounty in the escrow with the worker as receiver. If the assignment's
   answer is lost, the same authorization is sent again; no second one is signed for another applicant while an earlier
   one can still be used (until its `validBefore`), so two escrows can never lock for one task.
4. **The human delivers**, as a `text_response`.
5. **Flat Fee reviews it.** It opens every delivery first (`POST /api/v1/submissions/{id}/evidence/open`), then reads
   EM's evidence manifest (what the delivery holds, not what it says) and the text. A delivery with no text answer, an
   empty or blank one, or one longer than 2000 bytes is **rejected with the reason** (severity `minor`: the same worker
   stays assigned and can deliver again, with no reputation hit). It is opened before it is rejected on purpose: EM
   keeps the escrow of a delivery its publisher read and then rejected (EM-7, `EM_REJECT_AFTER_READ_DISPUTE`, on in
   production), while one rejected unread is refunded to the merchant by EM's stranded-escrow sweep (every 600 s in
   production), after which nobody could be paid for the worker's next delivery. Any other delivery is kept as the
   buyer's answer and **approved**: EM releases the escrow to the worker (bounty minus EM's fee). Where EM's facilitator wants the payer's
   own release order, EM answers `LIFECYCLE_ORDER_REQUIRED` and Flat Fee approves again with it: an EIP-712
   `LifecycleOrder` over the `paymentInfo` of the escrow that locked, for its `maxAmount`, built with the SDK's
   `buildLifecycleAuth`. It is not sent unasked, since EM checks any order it receives. A delivery from an executor
   Flat Fee signed no escrow for is never approved. After three releases EM refused, Flat Fee stops approving and waits
   for a person (EM being unreachable or busy does not count).
6. **Flat Fee sends the worker 50 $WIF** (`WIF_WORKER_REWARD`) from the merchant wallet, to the wallet the escrow it
   signed pays (the worker is the one EM names, matched to that escrow), inside the same daily $WIF budget as the
   cashback. The reward goes out once per task, and only for a delivery Flat Fee accepted, or one EM released on its own
   that passes the same review; never for one Flat Fee rejected.
7. **The answer goes back to the buyer** at `GET /api/tasks/:id` (the 201 of `/api/hire` gives that link).

A background loop (`EM_POLL_SECONDS`) drives every open task through these steps, one task at a time, and survives
restarts as long as `DATA_DIR` does. Every step is re-derived from the task's status on Execution Market, so a step that
failed (EM unreachable, a timeout, a 5xx) is tried again on the next pass.

### Refused before anyone pays

A request Execution Market would refuse to publish by its own public rules is answered `400` before the 402, with the
reason, so the buyer can rephrase it without paying. The check runs on the exact title and instructions Flat Fee would
send (`src/emguard.ts`):

- text that is not well-formed Unicode (a lone surrogate, which EM's validator refuses) or that holds a NUL;
- a title that reads as a sale listing: EM's sell-intent rule (`services/sell_intent.py`: "for sale", "selling my" or
  "selling our", "we sell"), on in production;
- a pre-signed cloud URL or a cloud credential in the title or the instructions: EM's secret guard
  (`services/secret_guard.py`: AWS, GCP and Azure signed-URL parameters, an AWS access key id, a PEM private key). The
  error names the kind, never what matched.

EM's rules are Python regular expressions; the port takes Python's whitespace (`\s` there also covers U+001C-U+001F
and U+0085) and its case folds (U+0130, U+0131, U+017F and U+212A count as ASCII letters), and an ASCII word boundary,
so it refuses whatever EM refuses, and a few more (a non-ASCII letter glued to the phrase), where the buyer only has to
rephrase. EM's content review (`services/content_review.py`) cannot be checked this way: its rules are not in EM's
repository. A task it blocks ends unpublished, and that buyer is not refunded.

The title is the request on one line, cut at 80 code points (never inside an emoji).

Each pass also checks whether a new hire could run at all. Until the answer is yes, `POST /api/hire` answers `503`
before the 402 (asking the agent is not affected):

- Execution Market publishes an escrow for `NETWORK` whose chain, USDG, escrow, operator and token collector are Flat
  Fee's own (and lists `EM_PAYMENT_TOKEN` there, when it lists tokens);
- the escrow builder can build one: a dry run of the same `buildEscrowPreAuth` with a throwaway key (worthless, and
  never sent) proves the SDK has the chain's escrow row, and what it builds passes the same check as a real one;
- the merchant wallet holds one bounty of USDG for every hire whose escrow has not landed yet, plus one;
- Execution Market did not refuse the last publish for this server's settings or identity (the network, the token, the
  bounty, the deadline, the reputation network, `identity_required`, a refused signature, or any refusal that is not one
  of the task's own text or key): after such a refusal, hiring stays paused, across restarts (it is kept in
  `state.json`), until a publish goes through again or the `EM_*` settings change.

Until the first check answers, hires are refused too. A check that fails because EM or the RPC is unreachable keeps the
last answer (a hire paid then is published by the loop once EM answers again); EM refusing to show its escrow
parameters (a 4xx) pauses hiring. These checks see what Flat Fee can see before a payment: a publish can still be
refused for a reason they cannot read, and that buyer is then not refunded; a refusal of the settings or the identity
also stops the next buyers from paying.

`GET /api/info` says the same before anyone pays, so the landing page never says "Live" while hires are refused:
`hire.available` is the check above, and `hire.paused` is `{kind, reason}` while it fails, where `kind` is `unchecked`
(EM not reached since boot), `escrow` (EM's escrow on the network is not Flat Fee's, cannot be built, or EM refused to
show it), `refused` (EM refused the last publish for the settings or identity) or `funds` (the merchant cannot fund one
more escrow), and `reason` is one fixed sentence per kind (`publicPause` in `src/emhire.ts`) with no wallet, amount,
contract or EM text in it; the 503 keeps the full detail. `hire.expiry` (also in the 201 of `/api/hire`) tells the buyer
what becomes of a hire nobody finishes (`hireExpiry`): the task is on Execution Market for any of its people to take; if
nobody takes it by the deadline it is cancelled there, with nothing locked; if the person who took it does not deliver
by then, EM returns the escrowed pay to the merchant; the fee is not refunded either way.

How a publish EM did not take is handled (`publishRefusal` in `src/emhire.ts`):

| EM's answer | What Flat Fee does |
|---|---|
| unreachable, a timeout, 408, 429, a 5xx, `409 identity_registering`, or any refusal EM marks `retryable: true` (`422 task_content_review_unavailable`: its content review timed out, the text was not judged) | nothing was created: the same publish, with the same `Idempotency-Key`, goes out again on the next pass, until the deadline; hiring goes on |
| a refusal of the task's own text: `422` `sell_intent_rejected`, `embedded_secret_rejected`, `task_content_rejected`, `task_content_too_large`, or a validation `422` that names only `title` or `instructions` | that task ends `expired` with EM's reason; the next buyer's task is not refused for it, so hiring goes on |
| a `409` on the task's own key (`idempotency_key_spent`, `idempotency_key_conflict`) | that task ends `expired`; hiring goes on |
| anything else: the network or the token not enabled, the bounty outside EM's limits, the deadline, `invalid_reputation_network`, `403 identity_required`, a `401`, a validation `422` on any other field or on none it names | the task ends `expired` and hiring pauses (above) |

### When things do not go to plan

| Situation | What Flat Fee does |
|---|---|
| EM is unreachable or slow (each call times out), or refuses a publish it marks retryable | records the error on the task and retries on the next pass; nothing changes |
| EM refuses the task at publish for its own text or key | the task ends `expired`, with EM's reason; hiring goes on |
| EM refuses the task at publish for anything else (settings, identity) | the task ends `expired`, with EM's reason, and hiring pauses (above) |
| Nobody is assigned before the task's deadline | cancels it on EM (nothing was locked) and the task ends `expired` |
| The escrow lock fails for an applicant | the task goes back to `published` on EM; Flat Fee skips that applicant (unless EM says the failure was not theirs) and signs for the next once the failed authorization has expired |
| The assignment's answer is lost (timeout, 5xx) | Flat Fee keeps its pick; if EM did assign, it goes on; if not, the same authorization is sent again |
| The delivery fails the review | opened, then rejected with the reason: EM keeps the escrow (EM-7), so the same worker can deliver again until the deadline and be paid. If the deadline comes with only rejected deliveries, EM's deadline sweep sends the escrow to its arbitration (EM-7), not straight back to the merchant |
| EM sends the escrow of an assigned task back to the merchant anyway (`escrow_status` `refunding` or `refunded`: its sweep with EM-7 off, or a refund of its own) | Flat Fee cancels the task on EM, so no worker is left delivering into it, and ends it `expired`; it opens and approves nothing more for it, and no $WIF goes out |
| EM expires or cancels the task (no delivery in time) | the task ends `expired`; no $WIF is sent; EM refunds a locked escrow to the merchant |
| EM releases the escrow on its own (nobody reviewed in time, or arbitration) | Flat Fee reads the delivery and the task ends `done`; the $WIF goes out only if the delivery passes Flat Fee's review and was not rejected by it |
| The approval is queued (EM answers 202), or another one is already running | Flat Fee follows EM's settlement operation and does not approve again meanwhile |
| The release fails | approved again on a later pass, up to three refusals; an `unresolved` release is never approved again |
| An old lock failure is still on the task when the next assignment goes out | only a failure recorded after that assignment was sent counts against its applicant |

The buyer's USDG is not refunded when a task expires, the same as on the board today.

## What Flat Fee checks before the merchant signs an escrow

The merchant wallet pays every escrow, so its signature is only ever produced for this one shape:

- only the `escrow` scheme: Flat Fee never pays a worker directly, and never signs a server-built challenge;
- the network's escrow parameters that EM publishes (`GET /api/v1/h2a/payment-config`) must name the same chain id,
  USDG, escrow, operator and token collector as Flat Fee's own configuration (`EM_ESCROW_ADDRESS`,
  `EM_OPERATOR_ADDRESS`, `EM_TOKEN_COLLECTOR_ADDRESS`), or nothing is signed; the SDK then checks them again against its
  own tables;
- the escrow's token is read in one place (`escrowToken` in `src/escrow.ts`): `tokens[EM_PAYMENT_TOKEN]` where EM lists
  it (EM lists there only the tokens it takes payments in), else EM's `usdc` (Base and every USDC network, as before).
  On Robinhood Chain EM serves `usdc: null` and USDG under `tokens.USDG` (recorded in
  `test/fixtures/em-payment-config.json`), so that entry is the one read, with its own `domain_name` /
  `domain_version`, never the `usdc_domain_*` beside the null `usdc`. Its address must be `NETWORK`'s USDG and its
  domain exactly USDG's (`Global Dollar` / `1`), and a network that names no token at all is refused with a message
  that says so;
- the signed authorization is checked again after the SDK builds it: from the merchant, to the token collector, for
  exactly `EM_BOUNTY_USDG` of USDG, with the chosen worker as receiver and a nonce that commits to that payment;
- `EM_BOUNTY_USDG` can never be above the holder price of a hire, so a hire's price covers its bounty at either tier.
  The buyer pays `PAY_TO` and the merchant wallet pays the escrow (one wallet in this repo's deploy), so the merchant
  must hold the USDG: new hires are refused while it cannot fund one more.

## How Execution Market works, as read in its repository

Read from `UltravioletaDAO/execution-market` (`main` at `a675eb6`, 2026-11-04): its OpenAPI (`openapi/openapi.json`),
the agent guide (`dashboard/public/skill.md` and `skill/reference/escrow.md`) and the routes in `mcp_server/api`.

| Step | Endpoint | Notes |
|---|---|---|
| auth | every request signed with ERC-8128 (RFC 9421), a fresh nonce from `GET /api/v1/auth/erc8128/nonce` | signed with `uvd-x402-sdk/erc8128` (`signRequestWithSigner`), the SDK EM's own TypeScript guide points to |
| publish | `POST /api/v1/tasks` | `Idempotency-Key`; the publisher needs an ERC-8004 identity on Base (`403 identity_required` without one, `409 identity_registering` while it is being made, retryable); typed refusals carry `error` (snake_case), `code` (its UPPER twin) and `retryable`; a validation `422` lists `errors: [{field}]` |
| applicants | `GET /api/v1/tasks/{id}/applications` | publisher only; `wallet_address` is the worker's payout wallet |
| escrow parameters | `GET /api/v1/h2a/payment-config` | `escrow.networks[network]`, tier windows, fee bounds |
| assign + lock | `POST /api/v1/tasks/{id}/assign` with `X-Payment-Auth` | 202 `assigning` (poll the task: `accepted` = locked, back to `published` = lock failed) or 200 |
| delivery status | `GET /api/v1/tasks/{id}/submissions` | verdicts and `evidence_manifest`, never the evidence |
| read the delivery | `POST /api/v1/submissions/{id}/evidence/open` | records that the publisher read it |
| approve | `POST /api/v1/submissions/{id}/approve` (`lifecycle_order` when asked) | 200, or 202 + `GET /api/v1/settlement-operations/{op}`; `409 SETTLEMENT_OPERATION_IN_FLIGHT` names the operation to follow; `LIFECYCLE_ORDER_REQUIRED` when EM's facilitator wants the payer's release order (`EM_LIFECYCLE_PAYER_SIGNS`); an order that is sent is always checked |
| reject | `POST /api/v1/submissions/{id}/reject` | `{notes, severity}`; `minor` keeps the worker (the task goes back to `in_progress`). EM's stranded-escrow sweep (`jobs/stranded_escrow_sweeper.py`) refunds the escrow of a task with a rejected delivery, unless the publisher read that delivery first (EM-7) |
| cancel | `POST /api/v1/tasks/{id}/cancel` | used for a task nobody was assigned, and for one whose escrow EM already refunded |

EM's own TypeScript SDK (`sdk/typescript`) is not published to npm and holds only the ERC-8128 signer; the same signer
and the escrow builder ship in `uvd-x402-sdk`, already a dependency here.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EM_HIRE` | `off` | `on` sends `/api/hire` through Execution Market; `off` keeps the task board |
| `EM_API_URL` | (required when on) | Execution Market's API origin, `https://` |
| `EM_BOUNTY_USDG` | `0.20` | the worker's bounty, locked in escrow per task; at most `PRICE_HIRE_HOLDER_USDG` |
| `EM_DEADLINE_HOURS` | `24` | the task's deadline on EM (1-720) |
| `EM_POLL_SECONDS` | `30` | how often the loop advances open tasks |
| `EM_PAYMENT_TOKEN` | `USDG` | the token EM records for the task |
| `EM_ESCROW_ADDRESS`, `EM_OPERATOR_ADDRESS`, `EM_TOKEN_COLLECTOR_ADDRESS` | (required when on) | the escrow contracts on `NETWORK`, as deployed for Execution Market |
| `EM_REPUTATION_NETWORK` | (none) | optional, passed to EM as `reputation_network`; `robinhood` makes ratings land on the chain that paid (EM registers ERC-8004 identities on Robinhood Chain in production: `GET /api/v1/reputation/register/wallet/{wallet}?network=robinhood` answers where an unsupported network answers 400). A network EM refuses ends that task with `invalid_reputation_network` and pauses hiring |

`EM_HIRE=on` also needs `MERCHANT_PRIVATE_KEY`: the merchant wallet is Flat Fee's identity on Execution Market and the
payer of every escrow, so it must hold USDG for the bounties as well as $WIF and a little ETH for gas. `WORKER_TOKEN`
is not needed for hiring in this mode.

**The merchant wallet needs an ERC-8004 identity on Base before `EM_HIRE` goes on.** Execution Market requires one of
every publisher in production (`EM_REQUIRE_ERC8004=true`; `mcp_server/api/routers/tasks.py` at `a675eb6` answers
`403 identity_required` without it). The checks before the 402 cannot see it: without the identity, the first buyer
pays for a task EM refuses, and hiring then pauses. Register it once, gaslessly, with `npm run em:register`
(`scripts/em-register.ts`: `POST /api/v1/reputation/register` signed by the merchant wallet, EM's `skill.md`). It reads
EM's public status first (`GET /api/v1/reputation/register/wallet/{wallet}?network=base`), does nothing for a wallet
that already has an identity, follows a registration in flight instead of sending another, is a dry run unless
`CONFIRM_EM_REGISTER` is the merchant's own address, and waits until EM says `completed` (a publish meanwhile answers
`409 identity_registering`, which Flat Fee retries). Never register twice: a second registration can mint a duplicate
identity.

**`DATA_DIR` must persist while hires are open.** A task in flight, and the escrow authorization signed for it, live
there. The Lightsail recipe in `deploy/aws` has no volume: every restart or redeploy starts with an empty `DATA_DIR`,
and every `terraform apply` that changes the container's environment is a redeploy. A hire in flight across one is
orphaned: Execution Market still pays its worker (its own release, after the review window), but the buyer gets no
answer and the worker no $WIF. With that recipe, turn `EM_HIRE` on only for a demo window with no redeploy while hires
are open, or give it persistent storage first. Run one process per `DATA_DIR`, with no overlapping deploys: two
processes over one `state.json` each keep their own copy and could each pay a reward. Turning `EM_HIRE` off with hires
still open leaves them unattended too: nobody approves them and no $WIF goes out.

### Turning it on in the deploy

The container's whole environment with hiring through Execution Market on is `deploy/aws/em-hire.env` (no secrets:
`MERCHANT_PRIVATE_KEY` and `WORKER_TOKEN` keep the values the container has). `test/deploy.test.ts` loads that file the
way the server does, checks every `EM_*` value against EM's recorded payment-config for Robinhood Chain (and that the
SDK builds that escrow), and that each key reaches the container through `deploy/aws/main.tf` (`em_*` variables in
`terraform.tfvars`) and is in `.env.example`.

1. Once, before anything else: `npm run em:register` with the merchant's key, then again with
   `CONFIRM_EM_REGISTER=<the merchant's address>`, until it says `completed` (above).
2. One redeploy with the environment of `em-hire.env` (it also moves `PUBLIC_URL` to the public domain, below). The new
   container starts with an empty `DATA_DIR`.
3. `GET /api/info` answers `hire.via: "execution-market"` and, once the first check passed, `hire.available: true`.
4. `npm run e2e:hire` (below) buys one hire and follows it to the worker's payout.

**Off, at once:** `EM_HIRE=off` and nothing else (every other `EM_*` is then not read), in one redeploy; `/api/hire`
goes back to the task board, which needs the `WORKER_TOKEN` the container has. Hires open at that moment are left
unattended (above).

**`PUBLIC_URL`** is read in one place: the `resource` of every 402 (`src/app.ts`, both routes and both tiers). Nothing a
payment is matched on depends on it: `uvd-x402-sdk` matches a payment to the 402 by network, recipient and amount
(`resolvePaymentRequirement`), and an `X-UVD-Purchase` receipt is bound to the URL actually requested. So with
`PUBLIC_URL=https://flatfee.ultravioletadao.xyz`, a buyer on the domain gets a 402 that names the host they opened, and
one who comes in on the Lightsail URL gets the same 402 (naming the domain) and pays and is served the same
(`test/deploy.test.ts`). The page reads its own origin, and `/api/info` and Execution Market never see `PUBLIC_URL`.

### The end-to-end run (`npm run e2e:hire`)

One real hire on Robinhood Chain mainnet against the running deploy (`FLATFEE_URL`), from a machine whose `.env` holds
the keys (`scripts/e2e-hire.ts`, rules and run in `scripts/lib/hire.ts`). Before it reads the chain or signs anything,
it refuses unless the network is mainnet, `RPC_URL` is set and is not a public Robinhood Chain RPC, every amount it can
move is approved and matches the server's `/api/info` and quote (`CONFIRM_MAINNET_SPEND` the buyer's price,
`CONFIRM_MAINNET_BOUNTY` the escrow, `CONFIRM_MAINNET_REWARD` the worker's $WIF, `CONFIRM_MAINNET_WIF` the cashback),
the server hires through Execution Market and says `hire.available: true`, and the worker is neither the buyer, nor
`PAY_TO`, nor the merchant. Then the buyer pays over x402, the run follows the task on Flat Fee (every change of its
status, Execution Market's status as Flat Fee read it, the escrow, release and reward transactions), the worker applies
and, once its escrow locked, delivers a text answer; at the end it reads Execution Market's own last status as the
worker, and checks on chain that the buyer paid exactly the price and got the cashback, and that the worker got the
bounty less EM's fee and exactly the reward. It never prints a key, a session or the RPC URL.

The worker (`WORKER_MODE`): `erc8128` signs with its own wallet (`WORKER_PRIVATE_KEY`). Execution Market records how a
worker's request came in (`mcp_server/api/party.py`): a wallet that signs from a script is listed as an agent, and Flat
Fee assigns only people, so this mode also needs `WORKER_EM_CLIENT`, the client value the operator approved, which EM
lists as a person working through an agent. `token` uses a person's dashboard session (`WORKER_EM_TOKEN`), and
`manual` waits for a person on execution.market (`WORKER_WALLET`) to apply and deliver the text the run prints. If
someone else applies with a better reputation and Flat Fee picks them, the run says so and delivers nothing.

## Tests

`test/em.test.ts` runs the whole flow against a double of Execution Market's API (no network, no credentials). The
double checks every ERC-8128 signature with the SDK's verifier in EM's own posture (`em-lenient`), checks each escrow
authorization the way the facilitator would before locking it (signer, amount, token collector, receiver, nonce), and
plays publish (and its refusals, in the shapes EM's routes write them), applications, assignment (direct and queued),
delivery, approval (direct and queued), rejection, EM's stranded-escrow sweep (with EM-7 on, as in production, and
off), EM's own release and expiry, and the timeouts. The double plays Robinhood Chain testnet, where the SDK has no escrow
row, so those tests stand in for its builder with one that signs the same wrapper; Flat Fee's checks before and after
the builder are the real ones, and on the testnet the SDK's real builder is shown to refuse. `test/emtoken.test.ts` runs
the SDK's real builder through Flat Fee's signer on EM's recorded Base and Robinhood Chain entries, offline.

`test/hire.test.ts` runs `npm run e2e:hire`'s rules and run against a Flat Fee with `EM_HIRE` on, on Robinhood Chain
mainnet with the SDK's real escrow builder and EM's recorded payment-config, a double of Execution Market that plays
both the publisher's and the worker's routes (every ERC-8128 signature checked, the parties told apart as EM does) and
a fake chain that moves every balance: the whole hire to the worker's payout, a worker listed as an agent (never
assigned), a stranger picked first, a missing $WIF leg, a paused server (never paid), `reputation_network` refused, a
task nobody takes by its deadline (cancelled, nothing locked) and one taken but not delivered (EM's escrow back to the
merchant). `test/register.test.ts` runs `npm run em:register` against a double of EM's registration routes (an
identity already there, one in flight, a dry run, one registration, a failure, a timeout). `test/deploy.test.ts` checks
`deploy/aws/em-hire.env` and what `PUBLIC_URL` does.
