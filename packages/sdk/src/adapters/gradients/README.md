# Gradients (Bittensor SN56) adapter

The first shipped `ServiceAdapter` and the reference pattern the other launch
adapters follow. It wraps the Gradients fine-tuning subnet: given a task spec, it
fine-tunes a model on the subnet and returns a checkpoint plus an eval deliverable.
The Buyer and the escrow contract only ever see USDC; the USDC to TAO conversion is
adapter-internal and never crosses the `ServiceResult` boundary (the escrow vault holds
USDC only, and the branded `Tao` type of [`../bittensor`](../bittensor/index.ts) keeps TAO
out of it at compile time for the Bittensor trio).

`createGradientsAdapter()` exposes the swap, subnet-call, and pinning as injectable
ports so it runs and is tested without a live DEX, subnet, or IPFS node. A production
worker supplies real implementations (Jupiter for the swap, the SN56 dendrite,
Pinata or Arweave for pinning).

## The buyer is the judge

This adapter only produces the deliverable. Whether the eval clears the threshold is
decided by the buyer's `review.ts`, which independently recomputes the score from the
delivered artifact (`scoreGradientsDemoDeliverable` for the canned demo). The worker
never scores for release and never releases. The worker's self-reported eval number is
never trusted: a dishonest worker cannot self-release by claiming a passing score.

## Service payment path

A worker running this adapter needs to pay the underlying service. There are two
shapes, and the adapter README each reference bot ships states which one it uses:

- **USD-billed API (no TAO required).** Some Gradients access is resold through a
  USD-billed platform API: you fund an account with a card or USDC and call the API.
  Most launch workers take this path and never hold TAO. The `callSubnet` port calls
  the platform API; no swap is needed and the `swap` port can be a no-op.
- **Native TAO required.** Paying subnet miners directly requires TAO on Bittensor.
  The route is: swap USDC to canonical TAO on Solana via Jupiter, then bridge to
  Bittensor via the Wormhole NTT bridge (canonical TAO went live on Solana on
  2026-05-05). Centralized exchanges and wallet-to-wallet swap services (for example
  SideShift) are alternatives. Bridging is the worker's concern, never kit machinery:
  the kit manages no Bittensor keys and automates no bridge transactions.

## Float profile

Workers front the underlying service cost and are reimbursed in USDC only when the
buyer releases at the end of the job. Running this worker therefore requires working
capital proportional to the number of concurrent jobs:

- **Typical service cost fronted per job:** a Gradients fine-tune job runs roughly
  $10 to $200 of compute depending on dataset and model size (`pricingHint` in the
  kit's registry descriptor).
- **Payment timing:** the worker pays the service up front, at execute time. The
  escrow pays the worker (the full job amount, in USDC) only at release, after the
  buyer accepts. Between claim and release the job's cost is committed working capital.
- **Reimbursement:** USDC at release. The generated worker template's
  `maxConcurrentFloatUsdc` bound refuses to claim a new job when the summed in-flight
  service cost would exceed the configured working-capital limit, so the worker never
  claims more than it can fund.

## Canned demo job

`gradientsDemoJobSpec` is a deterministic fine-tune job (learn `y = 2x + 1` on a fixed
dataset, deliver predictions) with a fixed eval floor. It is the job the BuyerBot
template's five-minute journey hires this bot for. Because it is deterministic, a fresh
scaffold settles it with zero configuration, and the buyer's recompute always agrees on
a correct deliverable. Its spec hash is pinned by a test so the journey stays stable.
