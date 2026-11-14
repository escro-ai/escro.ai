# ZKML proof-verifier adapter

`createZkmlAdapter` wraps a zk-verified inference service behind the single
`ServiceAdapter` interface. The worker runs the model and attaches a proof that the
delivered output is the correct result of running a committed model on a committed
input. The worker pins one bundle document holding the deliverable and its proof, and
`ServiceResult.proofUri` is that document's reference. The Buyer configures
**auto-release on proof validation** with `zkmlProofAutoRelease`, resolving `proofUri`
through its own `resolveProofUri` port. Settlement is USDC
on Solana, refund by default, like every Escro job.

```ts
import {
  computeZkmlInputCommitment,
  createZkmlAdapter,
  zkmlDemoJobSpec,
  zkmlProofAutoRelease,
  ZKML_DEMO_MODEL_COMMITMENT,
} from "@escro/sdk";

// Worker: pin the bundle document to real storage; proofUri is its reference.
const adapter = createZkmlAdapter({ pin: (document) => ipfs.add(document) });
const result = await adapter.execute(zkmlDemoJobSpec);

// Buyer: resolve proofUri itself and pin the model and input it expects.
const decision = await zkmlProofAutoRelease({
  resolveProofUri: (uri) => gateway.fetch(uri),
  modelCommitment: ZKML_DEMO_MODEL_COMMITMENT,
  inputCommitment: computeZkmlInputCommitment(zkmlDemoJobSpec),
}).evaluate({ contentHash, proofUri });
// decision.accept === true  -> release_payment(); decision.dispute on a bad/missing proof.
```

## The buyer is the judge

Release judgment is NOT in this adapter and NOT in the protocol. The adapter only
PRODUCES the deliverable and its proof. Whether to release is the Buyer's
`zkmlProofAutoRelease` predicate, run in the Buyer's bot. The escrow program and the
oracle judge nothing (they never verify a proof), and the ZKML module imports no on-chain
or oracle code.

`zkmlProofAutoRelease` releases only when all of these hold: (1) the bundle's content
re-hashes to the worker-submitted `contentHash`; (2) the proof's `outputHash`,
`modelCommitment` and `inputCommitment` equal that hash, the model the buyer pinned and the
buyer's own commitment over its spec (`computeZkmlInputCommitment`), checked by the policy
whatever `verify` returns; and (3) `verify` accepts the proof. The submitted `contentHash`
is the WORKER's claim; integrity comes from the buyer recomputing `sha256(content)`, exactly
as the buyer template's `evalThresholdReview` does. Verification returns one of three outcomes:
`valid` (release), `invalid` (a usable proof that fails checks -> dispute), or `malformed`
(no proof, wrong scheme, undecodable -> dispute). Disputing rather than holding is
deliberate: a held `SUBMITTED` escrow auto-releases to the worker at the 24h protocol
timeout, so a buyer that required a proof contests a bad or missing one.

## The shipped verifier is a demo, NOT sound

The default scheme (`escro-zkml-ref-v1`) is a REFERENCE verifier with **no cryptographic
soundness**. Its verification tag is a plain keyless SHA-256 of the public inputs and
`buildZkmlProof` is exported, so any party can mint a proof that `verifyZkmlProof` accepts,
over whatever output it chooses and any model commitment. It exists to demonstrate the
lifecycle deterministically with no external prover: proof shape, the pinned bundle behind
`proofUri`, decode, and the buyer-side auto-release seam. **Never gate a production
auto-release on the default verifier alone.**

A production ZKML buyer passes a REAL SNARK/STARK verifier through the `verify` option of
`zkmlProofAutoRelease` (a verifying key over the same public inputs) -- that is where
soundness lives. Two disciplines carry over unchanged and are the load-bearing part:

1. **Verification stays in the buyer layer**, never on-chain and never in the oracle.
2. **The buyer always re-hashes the content** of the bundle it resolved and requires it
   equals the submitted `contentHash` before trusting anything.

## Proof transport

The worker pins one bundle document, `encodeZkmlProofUri({ content, proof })` (the
`zkml-proof:<base64url(json)>` form), through its `pin` port, and `proofUri` is that
document's reference, a short `ipfs://` or `ar://` URI that fits the escrow's `proof_uri`
field. The default `pin` only derives `ipfs://placeholder-<16 hex>` from the document's
SHA-256 and stores nothing, so a release needs a real pin. The Buyer's required
`resolveProofUri` port fetches the document; `decodeZkmlProofUri` returns the bundle, or
`null` for a foreign or undecodable document, and `verifyZkmlProofUri` checks the bundle's
content hash and its proof.

## Canned demo job

`zkmlDemoJobSpec` is a deterministic zk-verified classification. A worker with the default
inference and proving ports solves it and pins a bundle whose proof binds
`ZKML_DEMO_MODEL_COMMITMENT` and `computeZkmlInputCommitment(zkmlDemoJobSpec)`; with a real
pin and the buyer's `resolveProofUri`, `zkmlProofAutoRelease` accepts it under the reference
verifier.
