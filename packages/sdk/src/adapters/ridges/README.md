# Ridges (AI coding agents) adapter

A shipped `ServiceAdapter` that follows the reference pattern set by the Gradients
SN56 adapter. It wraps a Ridges coding agent: given a coding task, it runs the agent
to produce a solution, runs the task's test suite, and returns a test report as the
deliverable. The Buyer and the escrow contract only ever see USDC.

`createRidgesAdapter()` exposes the coding-agent call and pinning as injectable ports
so it runs and is tested without a live Ridges endpoint or IPFS node. A production
worker supplies real implementations (the Ridges platform API for `runAgent`, Pinata
or Arweave for pinning).

## The buyer is the judge

This adapter only produces the deliverable. Whether the test suite passed (exit 0) and
coverage cleared the target is decided by the buyer's `review.ts`, which independently
recomputes the outcome from the delivered test outputs (`scoreRidgesDemoDeliverable`
for the canned demo). The worker never scores for release and never releases. The
worker's self-reported pass/coverage is never trusted: a dishonest worker cannot
self-release by claiming a green suite while shipping wrong outputs.

## Service payment path

A worker running this adapter needs to pay the underlying service. Ridges takes the
first shape below, which is why its `serviceRef` is a bare `ridges` rather than a
`bittensor:<subnet>` id:

- **USD-billed API (no TAO required).** Ridges access is billed in USD through its
  platform API: you fund an account with a card or USDC and call the API. Workers on
  this path never hold TAO, and the adapter has no token conversion. The `runAgent`
  port calls the platform API; no swap step exists.
- **Native TAO (not this adapter).** The Bittensor adapters (gradients SN56, 404gen
  SN17, lium SN51) document the swap-and-bridge route for paying subnet miners in TAO
  (Jupiter USDC to canonical TAO, then the Wormhole NTT bridge to Bittensor). Ridges
  does not use it. Bridging, where it applies, is the worker's concern, never kit
  machinery: the kit manages no keys and automates no bridge transactions.

## Float profile

Workers front the underlying service cost and are reimbursed in USDC only when the
buyer releases at the end of the job. Running this worker therefore requires working
capital proportional to the number of concurrent jobs:

- **Typical service cost fronted per job:** a Ridges coding job runs roughly $5 to
  $100 depending on task size (`pricingHint` in the kit's registry descriptor).
- **Payment timing:** the worker pays the service up front, at execute time. The escrow
  pays the worker (the full job amount, in USDC) only at release, after the buyer
  accepts. Between claim and release the job's cost is committed working capital.
- **Reimbursement:** USDC at release. The generated worker template's
  `maxConcurrentFloatUsdc` bound refuses to claim a new job when the summed in-flight
  service cost would exceed the configured working-capital limit, so the worker never
  claims more than it can fund.

## Canned demo job

`ridgesDemoJobSpec` is a deterministic coding kata (implement FizzBuzz over a fixed
input battery and return a test report) with a fixed coverage target. It is the job the
BuyerBot template's five-minute journey hires this bot for. Because it is deterministic,
a fresh scaffold settles it with zero configuration, and the buyer's recompute always
agrees on a correct deliverable. Acceptance has both a pass and a fail side: a wrong
output means the suite did not pass (score 0), and a partial deliverable that covers too
little of the battery scores below the target. Its spec hash is pinned by a test so the
journey stays stable.
