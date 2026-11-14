# Lium (Bittensor SN51) adapter

A shipped `ServiceAdapter` following the Gradients adapter pattern. It wraps the Lium
GPU-compute subnet: given a task spec, it rents GPU compute on the subnet, runs the
job, and returns the job's output artifact. The Buyer and the escrow contract only
ever see USDC; the USDC to TAO conversion is adapter-internal and never crosses the
`ServiceResult` boundary (the escrow vault holds USDC only, and the branded `Tao` type of
[`../bittensor`](../bittensor/index.ts) keeps TAO out of it at compile time for the Bittensor
trio).

`createLiumAdapter()` exposes the swap, GPU-job call, and pinning as injectable ports
so it runs and is tested without a live DEX, subnet, or IPFS node. A production worker
supplies real implementations (Jupiter for the swap, the SN51 GPU-rental dendrite,
Pinata or Arweave for pinning).

## The buyer is the judge

This adapter only produces the deliverable. Whether the job is acceptable is decided by
the buyer's `review.ts`, which independently recomputes the scripted job's output and
checks completion, artifact presence, and a hash match against its own recompute
(`scoreLiumDemoDeliverable` for the canned demo). The worker never scores for release
and never releases. The worker's self-reported `artifactHash` is never trusted: a
dishonest worker cannot self-release by shipping a wrong artifact under a correct-looking
hash claim.

## Service payment path

A worker running this adapter needs to pay the underlying GPU service. There are two
shapes, and each reference bot's README states which one it uses:

- **USD-billed API (no TAO required).** GPU rental is commonly resold through a
  USD-billed platform API: you fund an account with a card or USDC and call the API to
  provision compute. A launch worker taking this path never holds TAO. The `runJob`
  port calls the platform API; no swap is needed and the `swap` port can be a no-op.
- **Native TAO required.** Renting GPU from SN51 miners directly requires TAO on
  Bittensor. The route is: swap USDC to canonical TAO on Solana via Jupiter, then bridge
  to Bittensor via the Wormhole NTT bridge (canonical TAO went live on Solana on
  2026-05-05). Centralized exchanges and wallet-to-wallet swap services (for example
  SideShift) are alternatives. Bridging is the worker's concern, never kit machinery:
  the kit manages no Bittensor keys and automates no bridge transactions.

## Float profile

Workers front the GPU cost and are reimbursed in USDC only when the buyer releases at
the end of the job. GPU jobs carry a heavier float than fine-tune jobs, so running this
worker requires more working capital per concurrent job:

- **Typical service cost fronted per job:** a Lium GPU job runs roughly $20 to $500 of
  rented compute depending on GPU class and duration (`pricingHint` in the kit's
  registry descriptor). Long-running or multi-GPU jobs sit at the top of that range.
- **Payment timing:** the worker pays for the GPU rental up front, at execute time. The
  escrow pays the worker (the full job amount, in USDC) only at release, after the buyer
  accepts. Between claim and release the rental cost is committed working capital, and
  GPU jobs hold that float for longer than a quick inference call.
- **Reimbursement:** USDC at release. The generated worker template's
  `maxConcurrentFloatUsdc` bound refuses to claim a new job when the summed in-flight
  service cost would exceed the configured working-capital limit, so the worker never
  claims more GPU time than it can fund.

## Canned demo job

`liumDemoJobSpec` is a deterministic five-minute scripted GPU job (a fixed hash chain
over a known seed) whose output artifact is reproducible. It is the job the BuyerBot
template's journey hires this bot for. Because it is deterministic, a fresh scaffold
settles it with zero configuration, and the buyer's independent recompute always agrees
on a correct deliverable. Its spec hash is pinned by a test so the journey stays stable.

## Shared Bittensor core

SN56 (gradients), SN17 (404gen) and SN51 (lium) share the same Bittensor port shape
(swap to TAO, subnet/GPU call, pin) and a branded `Tao` type. That shared skeleton lives
in `../bittensor/index.js` (`createBittensorSubnetAdapter` plus the `Tao` brand, the
swap/subnet-call/pin ports, and the default ports); this adapter supplies only its subnet
identity, capabilities, budget, and demo logic, and wires its GPU-rental port (`RunGpuJob`,
an alias of the shared `SubnetCall`) in as the core's `callSubnet`.
