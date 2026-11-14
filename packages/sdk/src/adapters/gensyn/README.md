# Gensyn adapter (REE proof as acceptance)

A `ServiceAdapter` for Gensyn-style **verifiable compute**. A worker runs a job in a
Reproducible Execution Environment (REE) and returns the deliverable plus an REE proof
that binds the task, the delivered output, and a reproducible execution transcript. What
this adapter adds over the network adapters is buyer-side **acceptance by proof**:
the Buyer auto-releases if and only if the REE proof verifies.

`createGensynAdapter()` exposes the compute, pinning, and health-check as injectable
ports so it runs and is tested without a live Gensyn job runner or IPFS node. A production
worker supplies real implementations (a real Gensyn job submission, a real pinner).

## The buyer is the judge

Escro judges nothing. This adapter only produces the deliverable and its proof; whether
that proof is acceptable is decided entirely at the **buyer layer** by `verifyReeProof` /
`gensynAutoRelease` (this module), exactly as the Gradients adapter's buyer recomputes the
eval score. Verification never enters the on-chain program or the oracle: this module
imports no on-chain or oracle code.

The worker's proof is **untrusted input**. `verifyReeProof` re-derives every field, so a
dishonest worker cannot self-release: a proof accepts only when all four bindings hold.

## What the REE proof binds

A `gensyn-ree-v1` proof carries `{ scheme, specHash, outputHash, steps, transcriptHash,
commitment }`. The buyer's verifier accepts only when:

1. **commitment** re-derives from the other fields (tamper-evidence over the tuple);
2. **outputHash** equals the SHA-256 of the content the buyer actually received AND the
   SHA-256 of the buyer's own reproduced deliverable. Binding both is what makes acceptance
   safe: without the second half a worker could attach a self-consistent proof to arbitrary
   content and still pass, so the delivered content must be the genuine output of the
   reproduced execution, not merely something the worker hashed;
3. **specHash** equals the SHA-256 of the commissioned task spec (the proof is for _this_
   job, not a different one);
4. **transcriptHash** and **steps** match the buyer's own reproduction of the execution (the
   essence of an REE: the buyer re-runs the reproducible compute and confirms the worker's
   transcript).

Anything else is rejected: a self-inconsistent proof, a proof for other content or another
spec, a non-reproducible transcript (all `invalid`), or a structurally broken proof (wrong
scheme, non-hex hash, non-positive `steps`, missing fields, all `malformed`). In every
rejecting case `gensynAutoRelease` returns `release: false`.

The reference verifier reproduces the full computation. A production Gensyn verifier would
replace the full recompute with Gensyn's interactive verification game over the same
`transcriptHash`; the acceptance contract is unchanged. The demo proof binds the spec but
not an escrow identity, so identical-spec escrows share a valid proof; that is harmless for
a deterministic public compute anyone can reproduce, but a production adapter should bind a
per-escrow/task nonce so a proof cannot be lifted between escrows.

## Proof transport

The worker pins one bundle document, `encodeGensynBundle({ content, proof })`, through its
`pin` port, and `proofUri` is that document's reference; the proof never travels on
`metadata`. The buyer resolves `proofUri` through its own `resolveProofUri` port (an IPFS or
Arweave gateway), `decodeGensynBundle` reads it, and the bundle's content must re-hash to the
on-chain `contentHash` before the proof is checked.

## Auto-release wiring

```ts
import { gensynProofAutoRelease, gensynDemoJobSpec } from "@escro/sdk";

const policy = gensynProofAutoRelease({
  resolveProofUri: (uri) => gateway.fetch(uri), // the buyer's own resolver; required
  spec: gensynDemoJobSpec,
});
const decision = await policy.evaluate({ contentHash, proofUri });
if (decision.accept) {
  await escro.releasePayment(escrowPda); // valid REE proof -> release to the worker
}
// Otherwise dispute: an invalid, malformed or unresolvable-to-a-bundle proof never releases.
// A resolver that throws propagates (retry it); it is never a verdict.
```

`gensynAutoRelease(bundle, { spec })` stays available for a buyer that assembled
`{ content, proof }` itself.

## Canned demo job

`gensynDemoJobSpec` is a deterministic reproducible compute (a fixed LCG walk from the seed
in its metadata, delivering the final result), so the buyer's reproduction always agrees on a
correct deliverable. Settling it needs three things: the worker resolves the buyer's
`gensynDemoJobSpec` as its task spec, the adapter pins its bundle through a storage the buyer
can read (a scaffolded worker pins through its configured `storage.endpoint`), and the buyer
runs `gensynProofAutoRelease` with its own `resolveProofUri` over that storage. The worker's
self-reported result is never trusted on its own; acceptance is the REE proof.

## Custody stays on Solana

Gensyn's own token handling, if any, is worker-internal. Nothing token-denominated crosses
the `ServiceResult` boundary; the Buyer and the escrow contract only ever see USDC
(the escrow vault holds USDC only). Custody remains Solana-only.
