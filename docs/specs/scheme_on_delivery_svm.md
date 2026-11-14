# Scheme: `on-delivery` `svm`

Version 0.1, 2026-11-07, draft. The Solana binding of [`on-delivery`](./scheme_on_delivery.md), with the Escro program
as its reference implementation.

Layout: x402's `specs/scheme_impl_template.md` as of x402-foundation/x402 commit
`513dd66d2b3eb2388065f9923d81aa496e626082` (the file last changed at `2f65c798410228410ea81a06d2f6ad636a56145e`). Core
types (`PaymentRequired`, `PaymentRequirements`, `PaymentPayload`, `SettlementResponse`, `/supported`) and the HTTP
headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) are those of `specs/x402-specification-v2.md` and
`specs/transports-v2/http.md` at the same commit.

## Summary

The client creates and funds an escrow on the Escro program in one `create_escrow` transaction, naming the server's
wallet as the assigned worker, and presents the escrow's address as its payment. The server reads the escrow back,
claims it with its own `claim_task`, does the work, and commits the deliverable's SHA-256 with `submit_deliverable`.
The client releases with `release_payment` or disputes with `raise_dispute`; when it stays silent for 24 hours after
the submission, the program lets the oracle authority release to the worker with `timeout_release`. A job not
submitted by its deadline is refunded to the client by `refund_buyer`, which anyone may send once the deadline plus 900
seconds (15 minutes) has passed. Only the buyer collects: every presentation of the escrow carries the buyer's
signature, and the server returns no job, poll result or resource without it.

The scheme's name (`scheme: "on-delivery"`) and the x402 payment flow (`extra.paymentFlow`, where V2 reserves the value
`escrow`) are different fields: an `on-delivery` entry may use the `escrow` flow, and the word `escrow` names no scheme.

### Roles on chain

| Scheme role | On chain | Set by | Signs |
| --- | --- | --- | --- |
| buyer | `escrow.buyer` | the `create_escrow` signer | `create_escrow`, `release_payment`, `cancel_escrow` (FUNDED only), `raise_dispute` |
| worker | `escrow.assigned_worker`, equal to `payTo` | the buyer, at creation; never changed | `claim_task`, `submit_deliverable`, `raise_dispute` |
| judge | the buyer | fixed in this version | as buyer |
| timekeeper | `PlatformConfig.oracle_authority` | set at platform initialisation; changed by the admin authority's `update_platform`, or reset when the program's upgrade authority closes PlatformConfig with `close_platform` and initialises it again with `initialize_platform` | `timeout_release` (only after `submitted_at` + 86400 s, checked on chain); it also sends `refund_buyer` as a crank, with no rights beyond any other caller's. It never signs `release_payment`, `claim_task`, `submit_deliverable`, `cancel_escrow`, `update_platform` or an arbitration instruction. |
| anyone | any signer | none | `refund_buyer`, once the deadline plus 900 s has passed before submission; it pays the escrow's buyer only |
| arbitrator | `AdminConfig.admin_authority` (PDA seeds `["admin"]`), a key the program requires to differ from `oracle_authority` | the program's upgrade authority | `arbitration_release`, `arbitration_refund`, from DISPUTED only, paying only the escrow's assigned worker or its buyer; a human decides off chain, the program evaluates no merits |

### Escrow profile: `on-delivery-svm-1`

`on-delivery-svm-1` is the program surface this binding reads and calls. The Escro program satisfies it; a program
that differs in any point below is a different profile.

| Point | Value |
| --- | --- |
| Program id | mainnet `4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr`; devnet `EjLpJ3obUYk1f2KDensU7UdGBZTxSdxufm7CSnMA3H5C` |
| Escrow PDA | seeds `["escrow", buyer (32 bytes), taskId (UTF-8, at most 32 bytes)]` under the program id |
| Vault | the associated token account of the escrow PDA (off curve) for the cluster's USDC mint; it holds `amount` plus the fee |
| PlatformConfig PDA | seeds `["config"]`; mainnet `7zPti535SmzvkdtmKaGR8w4niHLiEidWCqCaQXLbQvhn`, devnet `5BYnq9YsCTaMxBLJhBn4TPnCQuxiHcG5eZ2ygLJBu9dc`; Anchor discriminator `a04e8000f853e6a0`; fields in order `version` (u8), `fee_bps` (u16), `oracle_authority`, `usdc_mint`, `treasury` (32 bytes each), `bump` (u8) |
| USDC mint | mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; one per cluster, fixed at platform initialisation, checked by every escrow instruction (6 decimals) |
| Account version | every escrow instruction refuses an EscrowAccount or PlatformConfig whose `version` byte is not 1 |
| Minimum amount | `amount` of at least 5,000,000 (5 USDC), checked by `create_escrow` |
| Fee | `fee_bps` read from PlatformConfig at `create_escrow`, stored on the escrow, never supplied by a caller; fee = floor(`amount` x `fee_bps` / 10000), paid by the buyer on top of `amount` |
| Submission | `submit_deliverable` succeeds while the cluster clock is at or before `deadline` |
| Expiry refund | `refund_buyer` succeeds when the clock is after `deadline` + 900 and the escrow is FUNDED or IN_PROGRESS |
| Review window | `timeout_release` succeeds when the clock is at or after `submitted_at` + 86400 and the escrow is SUBMITTED |

#### EscrowAccount layout

Anchor discriminator `2445301280e17d87`, then the fields below in Borsh order. A string is a u32 length and its UTF-8
bytes; an `Option` is a one-byte tag then the value. Offsets after `task_id` therefore vary: decode in order.

| Field | Type | Read by this binding |
| --- | --- | --- |
| version | u8 | yes: must be 1 |
| buyer | 32 bytes | yes |
| assigned_worker | Option of 32 bytes | yes: always set; must equal `payTo` |
| task_id | string, at most 64 bytes allocated (32 usable as a seed) | yes |
| amount_usdc | u64 | yes: must equal `amount` |
| fee_bps | u16 | the client, after funding |
| deadline | i64 | yes |
| spec_hash | string, at most 64 bytes | yes: must equal `specHash` |
| deliverable_hash | Option of string, at most 64 bytes | the client, after submission |
| proof_uri | Option of string, at most 128 bytes | the client, after submission |
| state | u8, `EscrowState` | yes |
| created_at, updated_at | i64 each | no |
| submitted_at | Option of i64 | the client: the review window starts here |
| min_amount | u64 | no |
| bump | u8 | no |
| marketplace_id | Option of string | no: always absent |
| referrer_wallet | Option of 32 bytes | no: always absent |
| referrer_bps | u16 | no: always 0 |

#### `EscrowState` ordinals

| Ordinal | Variant | Scheme state | Note |
| --- | --- | --- | --- |
| 0 | Created | none | never persisted: `create_escrow` funds and sets Funded in one instruction |
| 1 | Funded | funded | |
| 2 | InProgress | claimed | |
| 3 | Submitted | submitted | |
| 4 | Completed | released | never seen on a live account |
| 5 | Disputed | disputed | |
| 6 | Refunded | refunded | never seen on a live account; `cancel_escrow` also ends here |

Every instruction that ends in Completed or Refunded closes the escrow account and its vault in the same instruction,
returning their rent to the buyer. A live escrow is therefore in state 1, 2, 3 or 5; a settled one is an absent
account, and its outcome is read from the settling transaction's event.

#### Events

Anchor `emit!`, logged as `Program data:` followed by the base64 of the discriminator (the first 8 bytes of
SHA-256 of `event:<Name>`) and the Borsh fields.

| Event | Discriminator | Emitted by | Scheme meaning |
| --- | --- | --- | --- |
| EscrowCreated | `467f69665c6107ad` | `create_escrow` | funded |
| TaskClaimed | `d05af374500fe4ca` | `claim_task` | claimed |
| DeliverableSubmitted | `80c66e2c4349ff63` | `submit_deliverable` | submitted; carries `deliverable_hash` and `proof_uri` |
| PaymentReleased | `a0849be82efe45db` | `release_payment`, `timeout_release`, `arbitration_release` | released |
| BuyerRefunded | `92ee74733ffe6bb0` | `refund_buyer`, `arbitration_refund` | refunded |
| EscrowCancelled | `62f1c37ad500a2a1` | `cancel_escrow` | refunded, presented as cancelled |
| DisputeRaised | `f6a76d258e2d26b0` | `raise_dispute` | disputed; carries the reason |

#### Instructions

Discriminator: the first 8 bytes of SHA-256 of `global:<name>`.

| Instruction | Discriminator | Signer | From state | Effect |
| --- | --- | --- | --- | --- |
| `create_escrow` | `fdd7a574246c4450` | buyer | none | Funded; deposits `amount` plus the fee |
| `claim_task` | `31dedbee9b44dd88` | assigned worker | Funded | InProgress |
| `submit_deliverable` | `2689402ced0b7d65` | assigned worker | InProgress, clock at or before `deadline` | Submitted; sets `submitted_at` |
| `release_payment` | `1822bf5691a0b7e9` | buyer | Submitted | Completed; `amount` to the worker, the fee to the treasury, closed |
| `timeout_release` | `62b01a0c53699a44` | oracle authority | Submitted, clock at or after `submitted_at` + 86400 | as `release_payment` |
| `refund_buyer` | `c78bcb92c09635da` | anyone | Funded or InProgress, clock after `deadline` + 900 | Refunded; `amount` plus the fee to the buyer, closed |
| `cancel_escrow` | `9ccb36b326482115` | buyer | Funded | Refunded; `amount` plus the fee to the buyer, closed |
| `raise_dispute` | `29f30133965ff649` | buyer or assigned worker | InProgress or Submitted | Disputed; reason of at most 200 bytes |
| `arbitration_release` | `769d8d1a68755ee5` | admin authority | Disputed | Completed, as `release_payment` |
| `arbitration_refund` | `ffc254f8b9f9787a` | admin authority | Disputed | Refunded, as `refund_buyer` |

### PaymentRequirements

A 402 offering the job beside an `exact` price for the same route (the `exact` entry is shown only for contrast; its
`extra.feePayer` is a public key, as the `exact` SVM scheme defines it):

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://worker.example.com/v1/summarise",
    "description": "Summarise a PDF in at most 300 words",
    "mimeType": "text/markdown"
  },
  "accepts": [
    {
      "scheme": "on-delivery",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "25000000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "3y3f4Hia3hhwEt3ZwW2wu2xYzG69bAHwUYSjz7K89gcs",
      "maxTimeoutSeconds": 120,
      "extra": {
        "program": "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr",
        "specHash": "96ace2d4658ad6505ab4e90248bb8342ddd6c616fa19a8673c2fbb75b7467b30",
        "specUri": "https://worker.example.com/specs/96ace2d4658ad6505ab4e90248bb8342ddd6c616fa19a8673c2fbb75b7467b30.json",
        "deadline": 1795000000,
        "reviewWindowSeconds": 86400,
        "feeBps": 50,
        "feePayer": "client",
        "settlementMode": "release",
        "paymentFlow": "upfront"
      }
    },
    {
      "scheme": "exact",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "amount": "25000000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "3y3f4Hia3hhwEt3ZwW2wu2xYzG69bAHwUYSjz7K89gcs",
      "maxTimeoutSeconds": 60,
      "extra": {
        "feePayer": "oATmqnVYH1aG2tSMUm5PM73SGFYUmtbuTRRXZS6hsMG"
      }
    }
  ]
}
```

#### `PaymentRequirements` fields

| Field | Value for `on-delivery` |
| --- | --- |
| `scheme` | `"on-delivery"` |
| `network` | the cluster's CAIP-2 id (Appendix) |
| `amount` | the job amount in micro-USDC, a decimal string: the escrow's `amount_usdc`, what the worker receives on release. The client deposits `amount` plus floor(`amount` x `feeBps` / 10000). At least `5000000`. |
| `asset` | the cluster's USDC mint |
| `payTo` | the worker's wallet, which becomes `assigned_worker`. Its USDC associated token account must exist before any release: the program does not create it, and a release to a missing account fails. |
| `maxTimeoutSeconds` | the time the client has to fund the escrow and present the payload after the 402 |
| `extra` | the fields below |

#### `extra` fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `program` | yes | base58 public key | The program id. The client compares it with the id it trusts for `network` and skips the entry on a mismatch. |
| `specHash` | yes | 64 lowercase hex characters | The `spec_hash` the escrow must carry (Job specification). |
| `specUri` | yes | `https:` or `ipfs:` URI | Where the client fetches the job specification whose hash is `specHash`. |
| `deadline` | yes | integer, Unix seconds | The submission deadline the escrow must carry at least. |
| `reviewWindowSeconds` | yes | integer | `86400`: the program's fixed window. A client refuses any other value in this version. |
| `feeBps` | yes | integer, 0 to 10000 | PlatformConfig `fee_bps` read on chain when the 402 was built, so the client can price its deposit. The client re-reads it before signing and skips the entry on a mismatch. |
| `feePayer` | yes | `"client"` | The fee is added to the deposit and paid by the client; the worker receives `amount`. The only value this version offers. Unlike `exact`'s `extra.feePayer`, it names a party, not a transaction fee payer. |
| `settlementMode` | yes | `"release"` | Silence after the review window releases to the worker (`timeout_release`); rejection is `raise_dispute` to arbitration. `refund` is offered from a future account layout; a v1 server advertises `release`, and a client that cannot accept it skips the entry. |
| `paymentFlow` | yes | `"upfront"` \| `"escrow"` | `upfront` (the default for async work): the server claims, answers at once with a poll reference, and submits later. `escrow`: the server claims, does the work within the request, submits, and returns the resource. |

`extra.assetTransferMethod` is not used: this binding has one method, the client's `create_escrow`. `extra` carries no
`taskId`: the client chooses it when it builds the create (see Job creation), and the server learns it from the
payload and checks it against the escrow's address.

#### `maxTimeoutSeconds`, `deadline` and the review window

| Bound | Governs |
| --- | --- |
| `maxTimeoutSeconds` | funding and presenting the payload, from the 402 |
| `deadline` | the worker's `submit_deliverable` (at or before it); the refund of an unsubmitted job opens at `deadline` + 900 |
| review window | `timeout_release`, from `submitted_at` + 86400; the buyer may release or dispute until it lands |

Between `deadline` and `deadline` + 900 an unsubmitted job can neither be submitted nor refunded. A server sets
`deadline` no earlier than now plus `maxTimeoutSeconds` plus the time the work takes. The program requires only that
`deadline` is in the future at creation; Escro's API create path also requires it to be between 60 seconds and 30 days
ahead.

### Job specification

`specHash` is the lowercase hex SHA-256 of the UTF-8 bytes of the reduced job specification in the JSON
Canonicalization Scheme (JCS, RFC 8785). The reduction keeps the TaskSpec's schema keys only (`version`, `taskType`,
`description`, `acceptanceCriteria` with each criterion's `id`, `description`, `weight` and `required`,
`deliverableFormat` with `type`, `schema`, `mimeType`, `maxSizeBytes` and `language`, and `metadata` kept whole) and
drops absent values; JCS then sorts every object's keys by UTF-16 code units, writes numbers in their shortest
round-trip form, writes non-ASCII characters as themselves and adds no whitespace (`computeTaskSpecHash` in Escro's
shared package). The server serves the document at `specUri`; the client fetches it, recomputes the hash and skips the
entry on a mismatch. The document the example above commits to:

```json
{
  "version": "1.0.0",
  "taskType": "summarization",
  "description": "Summarise the PDF at the input URI in at most 300 words, keeping every figure and date.",
  "acceptanceCriteria": [
    { "id": "length", "description": "At most 300 words.", "weight": 0.35, "required": true },
    {
      "id": "figures",
      "description": "Every figure and date in the source appears unchanged.",
      "weight": 0.4,
      "required": true
    },
    {
      "id": "currency",
      "description": "Amounts keep the symbols the source uses: €, £, ¥.",
      "weight": 0.25,
      "required": false
    }
  ],
  "deliverableFormat": { "type": "text", "mimeType": "text/markdown" },
  "metadata": { "inputUri": "https://worker.example.com/inputs/q3-report.pdf" }
}
```

### Job creation

The client creates and funds the job in one transaction carrying one `create_escrow` instruction, signed by the
client, with:

- `task_id`: chosen by the client, unique for its wallet, at most 32 bytes (Escro's API uses 32 hex characters from a
  random UUID);
- `amount` = `amount`; `deadline` at least `extra.deadline`; `spec_hash` = `extra.specHash`;
- `assigned_worker` = `payTo` (required: the program refuses an escrow with no worker);
- accounts: the buyer (signer, pays the rent of the escrow account and the vault), PlatformConfig, the USDC mint, the
  buyer's USDC associated token account, the escrow PDA and the vault (both created here), and the System, token and
  associated token programs.

The program reads `fee_bps` from PlatformConfig and moves `amount` plus the fee from the buyer to the vault in the same
instruction. There is no separate budget step: the escrow is funded the moment it exists. The rent of the escrow and
the vault is the buyer's and returns to the buyer when the escrow closes.

## Payment payload

Over HTTP the client sends the `PaymentPayload` in the `PAYMENT-SIGNATURE` header (base64 JSON), after its
`create_escrow` has landed. `accepted` is the entry the client chose; the server does not trust it (Verification).

### Payload fields

| Field | Type | Meaning |
| --- | --- | --- |
| `escrow` | base58 public key | The escrow PDA. |
| `buyer` | base58 public key | The wallet that signed `create_escrow`. |
| `taskId` | string, at most 32 bytes | The `task_id` the escrow was created with. |
| `createSignature` | base58 signature | The landed `create_escrow` transaction, for the server's records. |
| `signedAt` | integer, Unix milliseconds | When the buyer signed `buyerSignature`. The server accepts it within 30 seconds of its own clock, either side. |
| `buyerSignature` | base58 Ed25519 signature (64 bytes) | The buyer's signature, by the key `buyer` names, over the buyer message below. It proves the presenter holds the buyer's key. |

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://worker.example.com/v1/summarise",
    "description": "Summarise a PDF in at most 300 words",
    "mimeType": "text/markdown"
  },
  "accepted": {
    "scheme": "on-delivery",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "25000000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "3y3f4Hia3hhwEt3ZwW2wu2xYzG69bAHwUYSjz7K89gcs",
    "maxTimeoutSeconds": 120,
    "extra": {
      "program": "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr",
      "specHash": "96ace2d4658ad6505ab4e90248bb8342ddd6c616fa19a8673c2fbb75b7467b30",
      "specUri": "https://worker.example.com/specs/96ace2d4658ad6505ab4e90248bb8342ddd6c616fa19a8673c2fbb75b7467b30.json",
      "deadline": 1795000000,
      "reviewWindowSeconds": 86400,
      "feeBps": 50,
      "feePayer": "client",
      "settlementMode": "release",
      "paymentFlow": "upfront"
    }
  },
  "payload": {
    "escrow": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA",
    "buyer": "3WvsPQFigdnkBkfj4uHqV5N5mxkV3mRXm7oCMP3knLfV",
    "taskId": "3f9c2a7be1d04c58a6e2f0b9d7c41e36",
    "createSignature": "UCZ6iUzoLs5pCVMV71DZU1u8kLGiPqQ88V6xjtDcxdV9TKvtCbXUSxSDvu3bGumQKuhvhd7PtSDZjBgoGB1Qdo1",
    "signedAt": 1794996012345,
    "buyerSignature": "67g6jDJRe3VsF7fQvQJ2BM75gBgagrVp5mRgjA1DguLFiDZ5qYTPF3HJbowAPJLpoQr6PDWxPSzyw1D4L8ASDghd"
  }
}
```

`escrow`, `buyer`, `taskId` and `createSignature` are public on chain once the escrow exists and prove only which
escrow pays; `buyerSignature` proves the presenter is its buyer. A payload without a valid one collects nothing.

#### Buyer message

`buyerSignature` signs the UTF-8 bytes of:

```text
escro:<signedAt>:ON-DELIVERY:<resource>:<escrow>
```

`<signedAt>` is `signedAt` in decimal, `<escrow>` is `escrow`, and `<resource>` is the absolute URL the request is sent
to: the paid route (`resource.url`) for the paid request, the `poll` URL for a poll. This is the message of Escro's API
request signing (`buildSignedMessage(timestamp, method, path, bodyHash)` in Escro's shared package) with `ON-DELIVERY`
in the method place, the resource in the path place and the escrow in the body-hash place. `ON-DELIVERY` is no method
Escro's API accepts and the resource is an absolute URL, so a payload signature never verifies as an API request signature, and an
API request signature never verifies as a payload. The server builds the message from the URL it is serving, never
from a URL the client sends.

## Verification

### Client, before funding

1. `network` is the CAIP-2 id of the client's cluster, and `extra.program` the program id it trusts for that cluster.
2. `asset` is the cluster's USDC mint and equals PlatformConfig `usdc_mint`.
3. `extra.feeBps` equals PlatformConfig `fee_bps`, read on chain.
4. `extra.settlementMode` is one the client accepts (`release` in this version), `extra.reviewWindowSeconds` is 86400,
   `extra.feePayer` is `client`, and `extra.paymentFlow` is one it recognises.
5. `amount` is at least 5000000; `payTo` is a canonical public key.
6. `extra.deadline` is in the future and leaves the work the time the client expects it to take.
7. The document at `extra.specUri` hashes to `extra.specHash`.
8. Its own spending policy admits `amount` plus the fee.

A client whose create transaction is built by another party (Escro's API builds it unsigned) checks before signing
that it carries exactly one `create_escrow` of this program with these arguments and accounts.

### Server, per paid request

The server, or a facilitator acting for it, checks the payload against requirements it derives itself for the request
and never against `accepted`, which the client wrote. It reads the escrow over RPC at `confirmed` or stronger:

1. The payload has exactly the six fields, each well formed, and `taskId` is at most 32 bytes.
2. `escrow` is the PDA of (`extra.program`, `buyer`, `taskId`).
3. `buyerSignature` verifies under `buyer` over the buyer message the server builds from `signedAt`, the URL it is
   serving and `escrow`, and its S is canonical (S < L, RFC 8032 section 5.1.7), since a verifier without that check
   accepts (R, S + L) as a second signature over the same message; `signedAt` is within 30 seconds of the server's
   clock; and the server has not accepted this signed message (`buyer`, `signedAt`, resource, `escrow`) before. The
   record keys on the message, never on the signature bytes, and is kept until `signedAt` + 30 seconds has passed on
   the server's clock, so no signature it covers still verifies once it lapses. The server checks this before it
   reads the escrow, sends a claim or returns anything.
4. The account exists, is owned by `extra.program`, carries the EscrowAccount discriminator and `version` 1.
5. `buyer` equals `payload.buyer`, so the signer of step 3 is `escrow.buyer`; `assigned_worker` equals `payTo`;
   `amount_usdc` equals `amount`; `spec_hash` equals `extra.specHash`; `deadline` is at least `extra.deadline` (a
   server that re-derives `extra.deadline` from the clock at verification first subtracts `maxTimeoutSeconds`, so a
   client that paid inside the window is accepted).
6. `state` is Funded: the server sends `claim_task` and starts the work only when that claim lands. Two requests
   presenting one escrow start the work once, because a claim succeeds only once. State InProgress or Submitted with
   this server as `assigned_worker` is a retry: the server answers with the existing job and starts nothing. Any other
   state, or an absent account, is not a payment.

Only the buyer collects. A second presenter of an escrow, Funded, InProgress or Submitted, that cannot sign as
`escrow.buyer` fails step 3 with `invalid_on_delivery_svm_buyer_signature`: it receives no poll reference, no poll
result and no resource, and the server sends no claim for it. The buyer itself, re-signing with a fresh `signedAt`,
receives the existing job.

A poll is a request too. It carries the `PAYMENT-SIGNATURE` header with the same payload, re-signed over the `poll`
URL with a fresh `signedAt`, and the server runs steps 1 to 3 and checks that `buyer` is the buyer of the job it holds
for `escrow` before it returns a status or a result. The escrow account may be closed by then: the buyer recorded when
the server claimed, not the account, names who may read.

The server does not compare `fee_bps`: the fee is the client's cost, and the worker receives `amount` whatever it is.
`createSignature` is for reconciliation; the account read, not the signature, decides.

### Error codes

Reasons this binding defines are namespaced `invalid_on_delivery_svm_*`; the core reasons (`invalid_network`,
`invalid_scheme`, `invalid_payload`, `invalid_payment_requirements`, `invalid_x402_version`) keep their names.

| Reason | When |
| --- | --- |
| `invalid_on_delivery_svm_payload` | a payload field is missing, extra or malformed, or `taskId` exceeds 32 bytes |
| `invalid_on_delivery_svm_escrow_address_mismatch` | `escrow` is not the PDA of the program, `buyer` and `taskId` |
| `invalid_on_delivery_svm_buyer_signature` | `buyerSignature` does not verify under `buyer` over the buyer message for this URL and `escrow`, or was already accepted |
| `invalid_on_delivery_svm_signature_expired` | `signedAt` is more than 30 seconds from the server's clock; the buyer re-signs |
| `invalid_on_delivery_svm_escrow_not_found` | no account at `escrow` |
| `invalid_on_delivery_svm_escrow_owner` | the account is not owned by the program, or is not an EscrowAccount |
| `invalid_on_delivery_svm_escrow_version` | the account's `version` is not 1 |
| `invalid_on_delivery_svm_wrong_state` | the escrow is not Funded, and not a retry of this server's job |
| `invalid_on_delivery_svm_buyer_mismatch` | the escrow's `buyer` differs from `payload.buyer` |
| `invalid_on_delivery_svm_worker_mismatch` | `assigned_worker` differs from `payTo` |
| `invalid_on_delivery_svm_amount_mismatch` | `amount_usdc` differs from `amount` |
| `invalid_on_delivery_svm_spec_hash_mismatch` | `spec_hash` differs from `extra.specHash` |
| `invalid_on_delivery_svm_deadline` | the escrow's `deadline` is earlier than the requirements allow |
| `invalid_on_delivery_svm_claim_failed` | the server's `claim_task` did not land (the buyer cancelled, or another request claimed first) |

Program errors a server may meet on its own transactions: `InvalidState` (the escrow left the expected state),
`UnauthorisedWorker` or `NotTaker` (signer is not `assigned_worker`), `DeadlineExceeded` (submission after
`deadline`).

## Settlement

### What settles, and who signs

In x402 terms the settle before the resource is the server's verification plus its landed `claim_task`; under the
`escrow` flow the second settle is `submit_deliverable`. Neither moves funds to the worker. Funds leave the vault only
by `release_payment` (the buyer), `timeout_release` (the oracle authority, after the review window), `refund_buyer`
(anyone, after the deadline plus 900 s, before submission), `cancel_escrow` (the buyer, while Funded), or arbitration.

`claim_task` and `submit_deliverable` are signed by the worker's own key: the server is its own facilitator by default
and holds no key but its wallet's. A separate fee payer (a Kora-style relayer) may pay their transaction fees; it
holds no role. Neither instruction allocates an account; the only rent is the escrow's and the vault's, paid and
recovered by the buyer.

### Payment flows

`upfront`: verify, land the claim, answer at once with the claim's `PAYMENT-RESPONSE` and a reference to poll, do the
work, then `submit_deliverable`. Each poll carries a payload re-signed by the buyer over the `poll` URL (Verification).

```http
HTTP/1.1 202 Accepted
PAYMENT-RESPONSE: <base64 SettlementResponse, transaction = the claim_task signature>
Content-Type: application/json

{"escrow": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA", "poll": "https://worker.example.com/v1/jobs/FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"}
```

`escrow`: verify, land the claim, do the work within the request, land `submit_deliverable`, and return the resource
with the submit's `PAYMENT-RESPONSE`. Offer it only when the work fits inside an HTTP call.

The SettlementResponse is the core type, unchanged:

```json
{
  "success": true,
  "transaction": "5cxwtyzzL6qEJ8XX4QrCejHGvDducAhywoZohKwVeHApnghYwzmo9VvVhwukXEUSL6Kfx3zPc8RpFgenrdT5Pauv",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "3WvsPQFigdnkBkfj4uHqV5N5mxkV3mRXm7oCMP3knLfV"
}
```

### Deliverable derivation

`deliverable_hash` is the lowercase hex SHA-256 (64 characters) of the delivered bytes: over HTTP, the response body
after transfer and content codings are removed and before it is parsed. `proof_uri` is optional, at most 128 bytes, an
`https:`, `ipfs:` or `ar:` URI where those bytes can be fetched; under `upfront` it is how the client obtains the
delivery. The program stores any string of up to 64 bytes in `deliverable_hash`; this binding fixes SHA-256 hex.

The client recomputes SHA-256 over the bytes it received and compares it with `deliverable_hash` in
`DeliverableSubmitted` or on the account. A match lets it release; a mismatch is a disagreement it can take to
`raise_dispute`, not proof of who is at fault.

### After submission

- **Release.** The buyer's `release_payment` from Submitted: the worker receives `amount`, the treasury the fee; any
  USDC donated to the vault goes to the worker; the escrow and vault close, rent to the buyer. Event `PaymentReleased`.
- **Review window.** With no decision, the oracle authority's `timeout_release` does the same once the clock is at or
  after `submitted_at` + 86400. Escro's oracle sends it 60 seconds after that, for clock skew.
- **Dispute.** The buyer or the worker sends `raise_dispute` from InProgress or Submitted, with a reason of at most 200
  bytes. A disputed escrow has no timeout; it resolves only by `arbitration_release` or `arbitration_refund`, signed by
  the admin authority after a human decides, paying only the escrow's worker or buyer.

### Expiry and withdrawal

- **Expiry.** Once the clock is after `deadline` + 900 with the escrow Funded or InProgress, any signer may send
  `refund_buyer`: `amount` plus the fee return to the buyer, the escrow and vault close. Event `BuyerRefunded`. Escro's
  oracle cranks it; the buyer or anyone else may.
- **Withdrawal.** While the escrow is Funded the buyer may `cancel_escrow` for `amount` plus the fee. Event
  `EscrowCancelled`. A server's claim on a withdrawn escrow fails, so it starts no work; claiming before working closes
  this window.

### `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "on-delivery",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "extra": { "program": "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr" }
    },
    {
      "x402Version": 2,
      "scheme": "on-delivery",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": { "program": "EjLpJ3obUYk1f2KDensU7UdGBZTxSdxufm7CSnMA3H5C" }
    }
  ],
  "extensions": ["escro"],
  "signers": {}
}
```

`extra.program` names the program the facilitator verifies against on that network. `signers` is empty when the
worker pays its own fees; a fee payer, if offered, is listed under `solana:*`.

## Appendix

### CAIP-2 network identifiers

| Cluster | `network` |
| --- | --- |
| mainnet | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |

Each is `solana:` followed by the first 32 characters of the cluster's genesis hash.

### `job-escrow` network requirements, answered

The `job-escrow` grammar (v0.1) lists ten points every binding states. This binding answers them, so a `job-escrow`
binding for Solana can be cut from it:

| Point | Here |
| --- | --- |
| 1. Escrow contract profile | `on-delivery-svm-1` (Escrow profile) |
| 2. Job creation | one `create_escrow` from the client, creating and funding (Job creation) |
| 3. Client authorization format | the landed create itself, named by the payload, and the buyer's `buyerSignature` over the escrow, the resource and `signedAt` on every presentation (Payment payload) |
| 4. Provider price commitment | the price is `amount`, written by the client's create; the server refuses an escrow whose `amount_usdc` differs. There is no server-signed budget. |
| 5. Evaluator acceptance | the judge is the buyer; there is no evaluator to accept |
| 6. Policy acceptance | none: the program has no hooks |
| 7. Deliverable derivation | SHA-256 hex of the delivered bytes, plus the optional `proof_uri` (Deliverable derivation) |
| 8. Verification and settlement | Verification; Settlement |
| 9. Expiry, timeout and grace | `maxTimeoutSeconds` bounds funding; `deadline` bounds submission; 900 s of grace before the expiry refund; the review window of 86400 s after submission |
| 10. Out-of-band claim activity | none in v1. The program has no claim settlement (no partial release), so nothing can delay the buyer's expiry refund. `claim_task` is the worker accepting the job, not a payout claim. |

### Security considerations

- **Echoed requirements.** A server that verified against `accepted` could be paid for a cheap route and serve an
  expensive one; it derives its own requirements per request.
- **One job per escrow.** Work starts only in the request whose claim landed.
- **Program and mint pinning.** The client trusts a program id and mint it already holds for the cluster, never the
  402's alone.
- **Fee drift.** The fee is read on chain at creation; a client that re-reads `fee_bps` before signing deposits
  exactly what it priced.
- **Worker token account.** A release to a worker with no USDC associated token account fails until one exists;
  anyone may create it. A server holds one before it claims.
- **The submission gap.** Between `deadline` and `deadline` + 900 an unsubmitted job is frozen; a server that cannot
  submit by `deadline` loses the job to the refund.
- **Buyer-only collection.** The escrow's address and its creation are public on chain, so the payload also carries
  `buyerSignature`; a presenter that cannot sign as `escrow.buyer` gets no claim, no poll result and no resource.
  `signedAt`, the canonical-S check and the server's record of accepted messages, keyed on (`buyer`, `signedAt`,
  resource, `escrow`) and kept until `signedAt` + 30 seconds, bound a replay to nothing: a malleated signature and a
  re-sent one both hit the record while the window lasts.

### Open questions

1. Closed: only the buyer collects. The payload carries `buyerSignature`, the buyer's Ed25519 signature over the
   escrow, the resource and `signedAt` (Buyer message), and the server requires it before it claims, answers a poll or
   returns the in-call resource.
2. `extra.feePayer` here names a party; under `exact` on SVM the same key holds a public key. Rename it (for example
   to `feeBearer`) before the name is relied on?
3. Should `deadline` be relative (seconds after funding) so a cached 402 stays valid? Absolute matches the program's
   field and ERC-8183's `expiredAt`.
4. Inline the job specification for small documents, or keep `specUri` only?
5. `settlementMode: "refund"` and a per-escrow review window wait on a future account layout. Should that layout be a
   new escrow profile, or an additive change to `on-delivery-svm-1`?

## Version history

| Version | Date | Changes |
| --- | --- | --- |
| 0.1 | 2026-11-07 | Initial draft. |
