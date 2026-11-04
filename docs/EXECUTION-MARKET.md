# Hiring a human through Execution Market

Flat Fee sells "hire a human for a small task" for a flat USDG price over x402. With `EM_HIRE=on`, Flat Fee does not
keep its own task board for that: it acts as an **agent on [Execution Market](https://execution.market)**, publishes the
task there, locks the worker's pay in a USDG escrow on Robinhood Chain, approves the delivery, and adds the $WIF reward
on top. With `EM_HIRE` off (the default), everything works exactly as before: the task goes on Flat Fee's own board.

The switch exists because Execution Market does not take Robinhood Chain tasks yet: its escrow (x402r) is not deployed
on Robinhood, its task API takes only `USDC` as `payment_token` today, and `uvd-x402-sdk` has no Robinhood row in its
escrow tables (checked on 2.106.0, the version pinned here, and on 2.111.0, the latest on npm on 2026-11-04). Until all
of that exists, a server with the knob on answers `503` to a hire **before** the 402 (see below), so nobody pays for a
task that cannot run, and the knob stays off on the live demo.

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
   `recommended: false`), never one that applied as an agent or a robot, never one whose escrow lock already failed,
   never the buyer's own wallet nor the merchant's. It builds the escrow authorization with the official builder,
   `buildEscrowPreAuth` from `uvd-x402-sdk`, signed by the merchant wallet, keeps it with the task (with the
   `paymentInfo` that releases or reclaims it), and sends it as `X-Payment-Auth` on `POST /api/v1/tasks/{id}/assign`. EM
   relays it to the facilitator, which locks the bounty in the escrow with the worker as receiver. If the assignment's
   answer is lost, the same authorization is sent again; no second one is signed for another applicant while an earlier
   one can still be used (until its `validBefore`), so two escrows can never lock for one task.
4. **The human delivers**, as a `text_response`.
5. **Flat Fee reviews it.** It reads EM's evidence manifest first (what the delivery holds, not what it says). A
   delivery with no text answer, an empty one or one too long is **rejected with the reason**, without opening it, so
   the worker can deliver again (severity `minor`: no reputation hit). Otherwise Flat Fee opens the evidence; a text that
   turns out blank or longer than 2000 bytes is rejected the same way, and any other is kept as the buyer's answer and
   **approved**, with the payer's release order (an EIP-712 `LifecycleOrder` over the escrow's `paymentInfo`, built with
   the SDK's `buildLifecycleAuth`), which EM's facilitator asks for where it enforces it: EM releases the escrow to the
   worker (bounty minus EM's fee). Approvals stop after three failed releases and wait for a person.
6. **Flat Fee sends the worker 50 $WIF** (`WIF_WORKER_REWARD`) from the merchant wallet, to the wallet the escrow it
   signed pays (the worker is the one EM names, matched to that escrow), inside the same daily $WIF budget as the
   cashback. The reward goes out once per task, and only for a delivery Flat Fee accepted, or one EM released on its own
   that passes the same review; never for one Flat Fee rejected.
7. **The answer goes back to the buyer** at `GET /api/tasks/:id` (the 201 of `/api/hire` gives that link).

A background loop (`EM_POLL_SECONDS`) drives every open task through these steps, one task at a time, and survives
restarts as long as `DATA_DIR` does. Every step is re-derived from the task's status on Execution Market, so a step that
failed (EM unreachable, a timeout, a 5xx) is tried again on the next pass.

### Refused before anyone pays

Each pass also checks whether a new hire could run at all. Until the answer is yes, `POST /api/hire` answers `503`
before the 402 (asking the agent is not affected):

- Execution Market publishes an escrow for `NETWORK` whose chain, USDG, escrow, operator and token collector are Flat
  Fee's own (and lists `EM_PAYMENT_TOKEN` there, when it lists tokens);
- the escrow builder can build one: a dry run of the same `buildEscrowPreAuth` with a throwaway key (worthless, and
  never sent) proves the SDK has the chain's escrow row;
- the merchant wallet holds one bounty of USDG for every hire whose escrow has not landed yet, plus one;
- Execution Market did not refuse the last publish outright (a 4xx that is not about that one task): after such a
  refusal, hiring stays paused until a publish goes through again, which in practice means a restart once the cause is
  fixed.

Until the first check answers, hires are refused too. A check that fails because EM or the RPC is unreachable keeps the
last answer (a hire paid then is published by the loop once EM answers again); EM refusing to show its escrow
parameters (a 4xx) pauses hiring. These checks see what Flat Fee can see before a payment: a publish can still be
refused for a reason they cannot read, and that buyer is then not refunded, but nobody after them pays.

### When things do not go to plan

| Situation | What Flat Fee does |
|---|---|
| EM is unreachable or slow (each call times out) | records the error on the task and retries on the next pass; nothing changes |
| EM refuses the task at publish (a 4xx that is not worth retrying) | the task ends `expired`, with EM's reason, and hiring pauses (above) |
| Nobody is assigned before the task's deadline | cancels it on EM (nothing was locked) and the task ends `expired` |
| The escrow lock fails for an applicant | the task goes back to `published` on EM; Flat Fee skips that applicant (unless EM says the failure was not theirs) and signs for the next once the failed authorization has expired |
| The assignment's answer is lost (timeout, 5xx) | Flat Fee keeps its pick; if EM did assign, it goes on; if not, the same authorization is sent again |
| The delivery fails the review | rejected with the reason; the same worker can deliver again until the deadline |
| EM expires or cancels the task (no delivery in time) | the task ends `expired`; no $WIF is sent; EM refunds a locked escrow to the merchant |
| EM releases the escrow on its own (nobody reviewed in time, or arbitration) | Flat Fee reads the delivery and the task ends `done`; the $WIF goes out only if the delivery passes Flat Fee's review and was not rejected by it |
| The approval is queued (EM answers 202), or another one is already running | Flat Fee follows EM's settlement operation and does not approve again meanwhile |
| The release fails | approved again on a later pass, three times at most; an `unresolved` release is never approved again |

The buyer's USDG is not refunded when a task expires, the same as on the board today.

## What Flat Fee checks before the merchant signs an escrow

The merchant wallet pays every escrow, so its signature is only ever produced for this one shape:

- only the `escrow` scheme: Flat Fee never pays a worker directly, and never signs a server-built challenge;
- the network's escrow parameters that EM publishes (`GET /api/v1/h2a/payment-config`) must name the same chain id,
  USDG, escrow, operator and token collector as Flat Fee's own configuration (`EM_ESCROW_ADDRESS`,
  `EM_OPERATOR_ADDRESS`, `EM_TOKEN_COLLECTOR_ADDRESS`), or nothing is signed; the SDK then checks them again against its
  own tables;
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
| publish | `POST /api/v1/tasks` | `Idempotency-Key`; a new publisher may get `409 identity_registering` (retryable) |
| applicants | `GET /api/v1/tasks/{id}/applications` | publisher only; `wallet_address` is the worker's payout wallet |
| escrow parameters | `GET /api/v1/h2a/payment-config` | `escrow.networks[network]`, tier windows, fee bounds |
| assign + lock | `POST /api/v1/tasks/{id}/assign` with `X-Payment-Auth` | 202 `assigning` (poll the task: `accepted` = locked, back to `published` = lock failed) or 200 |
| delivery status | `GET /api/v1/tasks/{id}/submissions` | verdicts and `evidence_manifest`, never the evidence |
| read the delivery | `POST /api/v1/submissions/{id}/evidence/open` | records that the publisher read it |
| approve | `POST /api/v1/submissions/{id}/approve` with `lifecycle_order` | 200, or 202 + `GET /api/v1/settlement-operations/{op}`; `409 SETTLEMENT_OPERATION_IN_FLIGHT` names the operation to follow; `LIFECYCLE_ORDER_REQUIRED` when EM's facilitator enforces the payer's release order (`EM_LIFECYCLE_PAYER_SIGNS`) |
| reject | `POST /api/v1/submissions/{id}/reject` | `{notes, severity}`; `minor` keeps the worker |
| cancel | `POST /api/v1/tasks/{id}/cancel` | used only for a task nobody was assigned |

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
| `EM_REPUTATION_NETWORK` | (none) | optional, passed to EM as `reputation_network`. Leave it empty until EM writes ERC-8004 reputation on Robinhood Chain (not yet: EM refuses `robinhood` there today), then set it to `robinhood` so ratings land on the chain that paid |

`EM_HIRE=on` also needs `MERCHANT_PRIVATE_KEY`: the merchant wallet is Flat Fee's identity on Execution Market and the
payer of every escrow, so it must hold USDG for the bounties as well as $WIF and a little ETH for gas. `WORKER_TOKEN`
is not needed for hiring in this mode.

**`DATA_DIR` must persist while hires are open.** A task in flight, and the escrow authorization signed for it, live
there. The Lightsail recipe in `deploy/aws` has no volume: every restart or redeploy starts with an empty `DATA_DIR`. A
hire in flight across one is orphaned: Execution Market still pays its worker (its own release, after the review
window), but the buyer gets no answer and the worker no $WIF. With that recipe, turn `EM_HIRE` on only for a demo window
with no redeploy while hires are open, or give it persistent storage first.

## Tests

`test/em.test.ts` runs the whole flow against a double of Execution Market's API (no network, no credentials). The
double checks every ERC-8128 signature with the SDK's verifier in EM's own posture (`em-lenient`), checks each escrow
authorization the way the facilitator would before locking it (signer, amount, token collector, receiver, nonce), and
plays publish, applications, assignment (direct and queued), delivery, approval (direct and queued), rejection, EM's
own release and expiry, and the timeouts. The SDK cannot build a Robinhood escrow yet, so the tests stand in for its
builder with one that signs the same wrapper; Flat Fee's checks before and after the builder are the real ones, the
SDK's real builder runs on Base through Flat Fee's signer, and on Robinhood it is shown to refuse.
