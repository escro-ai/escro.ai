# Akash (Cosmos) adapter

A shipped `ServiceAdapter` that extends the library beyond Bittensor. It wraps an Akash
deployment on the Akash decentralized cloud: given a task spec, it provisions a
deployment/lease, runs the compute job, and returns the job's output artifact. The Buyer
and the escrow contract only ever see USDC; the USDC to AKT conversion is adapter-internal
and never crosses the `ServiceResult` boundary (the escrow vault holds USDC only, and the
branded `Akt` type keeps AKT out of it at compile time).

`createAkashAdapter()` exposes the swap, deployment call, and pinning as injectable ports so
it runs and is tested without a live DEX, Akash provider, or IPFS node. A production worker
supplies real implementations (a DEX/CEX route for the USDC to AKT swap, the Akash SDL/lease
flow for the deployment, Pinata or Arweave for pinning).

## Not the Bittensor core

Like the Bittensor trio (gradients SN56, 404gen SN17, lium SN51), Akash bills in its own
token and converts USDC internally. But Akash is Cosmos-based, not a Bittensor subnet: its
id is a bare `"akash"`, not `bittensor:<subnet>`, so it does not use the shared
`../bittensor` core. It carries its own branded `Akt` type and its own USDC to AKT swap
port.

## No price feed

The default swap port converts at a fixed nominal reference rate
(`REFERENCE_MICRO_USDC_PER_AKT`), not a live price feed. The escrow contract takes no price
feed and holds USDC only; nothing here introduces one. A production worker
replaces the `swap` port with its own routing (a DEX quote, a CEX rate, a hedged desk), and
that routing stays entirely inside the worker layer.

## The buyer is the judge

This adapter only produces the deliverable. Whether the job is acceptable is decided by the
buyer's `review.ts`, which independently recomputes the scripted job's output and checks
completion, artifact presence, and a hash match against its own recompute
(`scoreAkashDemoDeliverable` for the canned demo). The worker never scores for release and
never releases. The worker's self-reported `artifactHash` is never trusted: a dishonest
worker cannot self-release by shipping a wrong artifact under a correct-looking hash claim.

## Service payment path

A worker running this adapter needs AKT to pay Akash providers. The route is: swap USDC to
AKT (a DEX or CEX route the worker chooses), then fund the deployment lease in AKT. Bridging
and key custody are the worker's concern, never kit machinery: the kit manages no Cosmos
keys and automates no bridge transactions.

## Float profile

Workers front the deployment cost and are reimbursed in USDC only when the buyer releases at
the end of the job. The worker pays for the Akash lease up front, at execute time; the escrow
pays the worker (the full job amount, in USDC) only at release, after the buyer accepts.
Between claim and release the lease cost is committed working capital. The generated worker
template's `maxConcurrentFloatUsdc` bound refuses to claim a new job when the summed in-flight
service cost would exceed the configured working-capital limit.

## Canned demo job

`akashDemoJobSpec` is a deterministic scripted batch compute job (a fixed hash chain over a
known seed) whose output artifact is reproducible. It is the job the BuyerBot template's
journey hires this bot for. Because it is deterministic, a fresh scaffold settles it with
zero configuration, and the buyer's independent recompute always agrees on a correct
deliverable. Its spec hash is pinned by a test so the journey stays stable.
