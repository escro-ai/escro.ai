# Render Network adapter

A shipped `ServiceAdapter` for decentralized GPU rendering on the Render Network: 3D
scene rendering, video frames, and diffusion/inference jobs. A Worker Bot wraps a Render
Network job behind the `ServiceAdapter` interface: given a task spec, it submits the
render job, collects the rendered output frame, and returns it as the `ServiceResult`
deliverable. The Buyer and the escrow contract only ever see USDC; the USDC to RENDER
conversion is adapter-internal and never crosses the `ServiceResult` boundary
(the escrow vault holds USDC only, and the branded `Render` type keeps RENDER out of it at
compile time).

`createRenderAdapter()` exposes the swap, render-job call, and pinning as injectable
ports so it runs and is tested without a live DEX, Render Network endpoint, or IPFS node.
A production worker supplies real implementations (a Solana DEX route such as Jupiter for
the swap, the Render Network job API for `runJob`, Pinata or Arweave for pinning).

## Solana-native, minimal bridging

RENDER is a Solana SPL token, so a worker funding a render job swaps USDC to RENDER with
a same-chain DEX route and never leaves Solana. There is no cross-chain bridge in the
path. This is the distinction from the Bittensor adapters (gradients SN56, 404gen SN17,
lium SN51), whose TAO must be bridged off Solana to the Bittensor chain. Because its token
and network differ, Render carries its own branded `Render` type and its own execute
skeleton and is deliberately not part of the shared `../bittensor` core.

No price feed lives in SDK core. The USDC to RENDER rate is the injectable `swap` port,
defaulting to a deterministic fixed reference rate; a production worker injects a real DEX
route. The SDK embeds no live price oracle, and the branded `Render` amount can never
reach a `ServiceResult` or the escrow submit path.

## The buyer is the judge

This adapter only produces the deliverable. Whether the render is acceptable is decided by
the buyer's `review.ts`, which independently re-renders the scripted demo scene and checks
completion, frame presence, and an exact frame match against its own re-render
(`scoreRenderDemoDeliverable` for the canned demo). The worker never scores for release and
never releases. The worker's self-reported `frameHash` is never trusted: a dishonest worker
cannot self-release by shipping a wrong frame under a correct-looking hash claim.

## Service payment path

A worker running this adapter needs to pay the Render Network for the render job. RENDER is
a Solana SPL token, so the route is entirely on Solana: swap USDC to RENDER on a Solana DEX
(for example Jupiter) and pay the job in RENDER. No bridge is involved. The `swap` port
performs the conversion and the `runJob` port submits the paid job; both are injected by a
production worker. Bridging and key management are the worker's concern, never kit
machinery: the kit manages no RENDER keys and automates no swap transactions.

## Float profile

Workers front the render cost and are reimbursed in USDC only when the buyer releases at the
end of the job.

- **Typical service cost fronted per job:** a Render Network job runs roughly $5 to $200 of
  rented GPU rendering depending on scene complexity, resolution, and frame count
  (`pricingHint` in the kit's registry descriptor). Long video renders sit at the top of
  that range.
- **Payment timing:** the worker pays for the render up front, at execute time. The escrow
  pays the worker (the full job amount, in USDC) only at release, after the buyer accepts.
  Between claim and release the render cost is committed working capital.
- **Reimbursement:** USDC at release. The generated worker template's `maxConcurrentFloatUsdc`
  bound refuses to claim a new job when the summed in-flight service cost would exceed the
  configured working-capital limit, so the worker never claims more render time than it can
  fund.

## Canned demo job

`renderDemoJobSpec` is a deterministic five-minute scripted render job: a fixed procedural
frame (a pure per-pixel shader over a fixed-size raster) whose output is reproducible. It is
the job the BuyerBot template's journey hires this bot for. Because it is deterministic, a
fresh scaffold settles it with zero configuration, and the buyer's independent re-render
always agrees on a correct deliverable. Its spec hash is pinned by a test so the journey
stays stable.
