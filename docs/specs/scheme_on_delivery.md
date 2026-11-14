# Scheme: `on-delivery`

Version 0.1, 2026-11-07, draft. Chain-agnostic grammar. Network bindings: [Solana](./scheme_on_delivery_svm.md)
(the Escro program is the reference implementation).

## Summary

`on-delivery` is an asynchronous x402 payment scheme for work that takes time. At the request the client locks the
price in an escrow that names the resource server as the worker; the server does the work and commits a hash of what
it delivered; the client judges the delivery and releases the funds, or disputes. Two clocks bound every job: a job
with no submission by its deadline refunds the client, and a submitted job settles by itself when its review window
ends with no decision.

Where `exact` pays at the request, `on-delivery` locks at the request and pays on delivery. The scheme never judges
the quality of a delivery: the client, or a judge it names, decides; the network enforces the transitions and the
clocks.

## Use cases

- An agent buys a report, a model run, a translation or a code change that takes minutes to days to produce.
- A worker wraps a long-running service (a training job, a render, a subnet call) and is paid only for work it
  delivered.
- A client wants its money back without anyone's cooperation when nothing is delivered in time.

## Roles

| Role | Party | What it does |
| --- | --- | --- |
| buyer | the x402 client, the payer | Funds the escrow at the request. Judges the delivery unless it names a judge. Recovers the funds when the deadline passes with no submission. |
| worker | the resource server (`payTo`) | Accepts (claims) the job, does the work, submits a commitment to the delivered bytes. Cannot release funds to itself. |
| judge | optional; defaults to the buyer | Releases the escrow to the worker, or disputes the delivery. A binding states who may hold the role. |
| timekeeper | named by the binding | Enforces the clocks: settles a submitted job when its review window ends, and may trigger the refund of an expired one. Judges nothing. |
| arbitrator | named by the binding | Resolves a disputed job to the worker or to the buyer, and to no one else. The recourse layer, outside the payment flow. |

## States

| State | Entered when | Leaves to |
| --- | --- | --- |
| funded | the buyer creates and funds the job in one step | claimed; refunded (the deadline passes with no submission, or the buyer withdraws before a claim where the binding allows it) |
| claimed | the worker claims the job | submitted; disputed; refunded (the deadline passes with no submission) |
| submitted | the worker commits its deliverable before the deadline | released; refunded (review window ends under `settlementMode: "refund"`); disputed |
| released | the judge releases, or the review window ends under `settlementMode: "release"`, or the arbitrator rules for the worker | terminal |
| refunded | an expiry, a withdrawal, a review window ending under `refund`, or the arbitrator ruling for the buyer | terminal |
| disputed | the buyer or the worker disputes a claimed or submitted job | released or refunded, by the arbitrator only |

There is no unfunded job: creating and funding are one step, so no state holds an offer nobody has paid for.

## Clocks

1. **Submission deadline** (`deadline`). An absolute time. The worker may submit until it passes. A job still funded
   or claimed after it refunds the buyer; a binding may add a short grace period, and anyone may trigger the refund,
   which pays the buyer only.
2. **Review window** (`reviewWindowSeconds`). Starts when the worker submits. Within it the judge releases or
   disputes. When it ends with no decision, silence settles the job per `settlementMode`. The window is a minimum, not
   a cut-off: until the settling transaction lands, the judge may still release or dispute.

A disputed job is bound by neither clock: it waits for the arbitrator. A fixed-direction timeout on a dispute would let
one side outlast the other.

## Wire fields

Every binding carries these fields in `PaymentRequirements.extra`, with these names and meanings. The core fields
keep their x402 meanings: `amount` is what the worker receives on release, `asset` the token, `payTo` the worker.

| Field | Type | Meaning |
| --- | --- | --- |
| `settlementMode` | `"release"` \| `"refund"` | What silence after the review window does: `release` pays the worker, `refund` returns the funds to the buyer. `release` is the scheme's default. A client that cannot accept the advertised mode skips the entry. |
| `reviewWindowSeconds` | integer | Length of the review window, in seconds, counted from submission. |
| `feePayer` | `"client"` \| `"worker"` | Which party bears the escrow operator's fee. `client`: the buyer deposits `amount` plus the fee and the worker receives `amount`. `worker`: the fee is deducted from `amount` on release. A binding states which it offers. |
| `deadline` | integer, Unix seconds | The submission deadline the worker commits to. |
| `specHash` | string | Commitment to the job's specification document; the binding fixes the hash function and where the document is found. |

The same fields, as a binding carries them inside `extra`:

```json
{
  "settlementMode": "release",
  "reviewWindowSeconds": 86400,
  "feePayer": "client",
  "deadline": 1795000000,
  "specHash": "7ab95ec4cca9a77877782f53f4b3889ba1d4e98cfd4f9678f46dbcd62bf25269"
}
```

## Core properties

- **Funds before work.** The worker starts only after it has read the funded escrow back from the network and its own
  claim has landed. A claim lands once, so one escrow starts at most one job.
- **The offer is checked against the escrow.** The server compares the escrow with requirements it derives itself
  for the request, never with requirements the client echoes back.
- **Release by the judge or the clock.** The worker has no path to its own payment; funds reach it only by the judge's
  release, the review window ending under `release`, or the arbitrator.
- **Refund by default.** A job with no submission by its deadline returns to the buyer, whoever triggers it.
- **Deliverable commitment.** A binding fixes one deterministic derivation from the delivered bytes, so the buyer can
  recompute it from what it received and compare it with what the worker committed. A mismatch exposes a
  disagreement; it does not by itself prove which side is at fault.
- **No quality judgement.** The scheme, its bindings and any timekeeper evaluate no deliverable. Deciding whether work
  is acceptable is the judge's alone.

## Network bindings

- [`scheme_on_delivery_svm.md`](./scheme_on_delivery_svm.md): Solana, on the Escro program.

## Appendix: `job-escrow` and ERC-8183

This appendix maps the grammar onto the x402 `job-escrow` drafts (`scheme_job_escrow.md` v0.1 and
`scheme_job_escrow_evm.md` v0.1, taco-paco/x402 branch `feat/erc-8183` at commit
`fb4ec00eecca6889726af4f398fc1e3c8f89fee1`, discussed in x402-foundation/x402 issue 3694) and onto ERC-8183 (Draft,
https://eips.ethereum.org/EIPS/eip-8183), so that a `job-escrow` binding for Solana can be cut from these documents
without renaming a field.

### Role mapping

| `on-delivery` | `job-escrow` | ERC-8183 | Difference |
| --- | --- | --- | --- |
| buyer | client | `client` | none |
| worker | provider (`payTo`) | `provider` | none |
| judge | evaluator | `evaluator` | `job-escrow` lists accepted evaluators in `extra.evaluators`, with `"client"` meaning the client judges; an `on-delivery` judge that is the buyer is `"client"` there. |
| timekeeper | none | none | ERC-8183's `claimRefund` after expiry is permissionless; it has no settle-on-silence path. |
| arbitrator | none | none | ERC-8183 defines no dispute path. |

### State mapping

| `on-delivery` | ERC-8183 `JobStatus` (ordinal in `job-escrow-evm-1`) | Difference |
| --- | --- | --- |
| none | `Open` (0) | `on-delivery` creates and funds in one step. |
| funded | `Funded` (1) | none |
| claimed | `Funded` (1) | ERC-8183 has no claim step; the provider is fixed at creation and works without one. |
| submitted | `Submitted` (2) | none |
| released | `Completed` (3) | none |
| refunded | `Rejected` (4) or `Expired` (5) | An `on-delivery` judge does not reject; it disputes. Expiry before submission maps to `Expired`; a review window ending under `refund` maps to `Expired` after the evaluation grace period. |
| disputed | none | No ERC-8183 counterpart. |

### Field mapping

| Field | `job-escrow` / ERC-8183 | Re-cut note |
| --- | --- | --- |
| `settlementMode` | none in `job-escrow`; ERC-8183's text behaves as `refund` (an unevaluated submitted job is refundable after expiry and grace) | Keep the field; `refund` is the ERC-8183 reading, `release` the settle-on-silence deployments. |
| `reviewWindowSeconds` | the evaluation grace period `job-escrow-evm-1` requires to exist | Same role: the time a submitted job is protected from expiry. |
| `feePayer` | fees deducted from the provider's payout (`job-escrow` EVM: the client is oblivious to them) | `job-escrow` EVM is `feePayer: "worker"`; the Solana binding offers `client`. |
| `deadline` | `extra.jobExpiresAt` = ERC-8183 `expiredAt` | `expiredAt` both bounds submission and opens the client's refund; `on-delivery` splits that into two clocks: the deadline bounds submission and opens the refund of an unsubmitted job, the review window governs a submitted one. |
| `specHash` | ERC-8183 `description` (the brief, stored on chain) | `on-delivery` stores a hash and serves the document; a re-cut carries the hash in the description or a hook parameter. |
| `amount` | `amount` = ERC-8183 `budget` | `job-escrow`'s amount is the gross budget the client escrows; under `feePayer: "client"` the client escrows `amount` plus the fee. |
| `payTo` | `payTo` = ERC-8183 `provider` | none |
| `paymentFlow` | `paymentFlow` (the same x402 reserved key) | `job-escrow` defaults to `escrow`; `on-delivery` defaults to `upfront`. |
| `deliverableHash` | ERC-8183 `deliverable` (`bytes32`) | Both commit to the delivered bytes; the Solana binding uses SHA-256 (64 hex characters, 32 bytes), `job-escrow` EVM uses keccak256. |
| `reason` | ERC-8183 `reason` (`bytes32` on `complete` and `reject`) | `on-delivery` puts no reason on a release. A judge MAY record its decision as a predicate memo beside the release (the `escro` extension's convention, which no program reads); its hash fills a `reason`. A dispute carries the binding's on-chain reason string. |

### What a re-cut must carry

- The fee: additive under `feePayer: "client"`, deducted under `worker`.
- Creation and funding as one transaction: no `Open` state, no separate `setBudget` or `fund`.
- The claim step between funding and submission.
- A buyer withdrawal before the claim where the binding offers one; `job-escrow`'s provider protection has none. The
  server closes that window by claiming before it starts work.
- The dispute path and its arbitrator.
- The deliverable hash function.
- The refund of an expired job applies only before submission.

## Version history

| Version | Date | Changes |
| --- | --- | --- |
| 0.1 | 2026-11-07 | Initial draft. |
