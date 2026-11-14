# 404gen (Bittensor SN17) adapter

A batch 3D-generation `ServiceAdapter`, built to the reference pattern the Gradients
(SN56) adapter established. It wraps the 404gen text-to-3D subnet: given a task spec, it
generates a batch of 3D assets and returns each asset's container format and polygon
count plus a proof URI. The Buyer and the escrow contract only ever see USDC; the USDC
to TAO conversion is adapter-internal and never crosses the `ServiceResult` boundary
(the escrow vault holds USDC only, and the branded `Tao` type of
[`../bittensor`](../bittensor/index.ts) keeps TAO out of it at compile time for the Bittensor
trio).

`create404genAdapter()` exposes the swap, subnet-call, and pinning as injectable ports
so it runs and is tested without a live DEX, subnet, or IPFS node. A production worker
supplies real implementations (Jupiter for the swap, the SN17 dendrite, Pinata or
Arweave for pinning).

## The buyer is the judge

This adapter only produces the deliverable. Whether the batch is acceptable is decided by
the buyer's `review.ts`. For the canned demo the buyer already knows the exact expected
artifact (the eval-threshold review re-verifies the fetched deliverable hashes to the
submitted contentHash) and gates on the deliverable's declared per-asset descriptors via
`score404genDemoDeliverable`: the declared container format must be GLB or PLY, the
declared polygon count must fall in range, and the batch must be complete. The worker
never scores for release and never releases, and its self-reported eval number is ignored.

Note that this descriptor recompute trusts the deliverable's own `format` and
`polygonCount` fields rather than the asset bytes. That is sufficient for the
deterministic demo (the buyer knows the correct artifact), but a production 404gen buyer
generating novel assets must derive the container from the fetched asset's magic bytes and
the polygon count from its parsed geometry before releasing. This is documented as debt in
the kit docs.

## Service payment path

A worker running this adapter needs to pay the underlying service. There are two shapes,
and the adapter README each reference bot ships states which one it uses:

- **USD-billed API (no TAO required).** Some SN17 access is resold through a USD-billed
  platform API: you fund an account with a card or USDC and call the API. Most launch
  workers take this path and never hold TAO. The `callSubnet` port calls the platform
  API; no swap is needed and the `swap` port can be a no-op.
- **Native TAO required.** Paying subnet miners directly requires TAO on Bittensor. The
  route is: swap USDC to canonical TAO on Solana via Jupiter, then bridge to Bittensor
  via the Wormhole NTT bridge (canonical TAO went live on Solana on 2026-05-05).
  Centralized exchanges and wallet-to-wallet swap services (for example SideShift) are
  alternatives. Bridging is the worker's concern, never kit machinery: the kit manages no
  Bittensor keys and automates no bridge transactions.

## Float profile

Workers front the underlying service cost and are reimbursed in USDC only when the buyer
releases at the end of the job. Running this worker therefore requires working capital
proportional to the number of concurrent jobs:

- **Typical service cost fronted per job:** a 404gen batch runs roughly $5 to $50 of
  compute depending on batch size and asset complexity (`pricingHint` in the kit's
  registry descriptor).
- **Payment timing:** the worker pays the service up front, at execute time. The escrow
  pays the worker (the full job amount, in USDC) only at release, after the buyer
  accepts. Between claim and release the batch's cost is committed working capital.
- **Reimbursement:** USDC at release. The generated worker template's
  `maxConcurrentFloatUsdc` bound refuses to claim a new job when the summed in-flight
  service cost would exceed the configured working-capital limit, so the worker never
  claims more than it can fund.

## Canned demo job

`gen404DemoJobSpec` is a deterministic batch 3D job (generate one asset in a GLB or PLY
container with a polygon count in range) with a fixed acceptance contract. It is the job
the BuyerBot template's five-minute journey hires this bot for. Because it is
deterministic, a fresh scaffold settles it with zero configuration, and the buyer's
recompute always agrees on a valid batch. Its spec hash is pinned by a test so the
journey stays stable.
