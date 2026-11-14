# Extension: `escro`

Version 0.4, 2026-11-13, draft. Schema: [`escro-extension.schema.json`](./escro-extension.schema.json) (JSON Schema,
draft 2020-12), published at `https://escro.ai/schemas/escro-extension/0.4.json`; the SHA-256 of its JCS form
(RFC 8785) is `87cb689d898f7304e577de1f11b11b95362e111cc610ea937f00433e226c13d3`. A companion of the
[`on-delivery`](./scheme_on_delivery.md) scheme, usable with any scheme and any network.

Layout and carrier types as in x402-foundation/x402 commit `513dd66d2b3eb2388065f9923d81aa496e626082`:
`specs/x402-specification-v2.md` (`PaymentRequired`, `PaymentPayload`, `SettlementResponse`, `/supported`, the
`extensions` object) and `specs/extensions/bazaar.md` (an extension's `info` and `schema`).

## Summary

`escro` tells a client, before it pays, how the delivery will be judged and how the job settles: the rule the judge
will apply (`acceptance`), where the outcome will be attested (`receipt`), what silence after the review window does
and who bears the fee (`settlement`), and which steps are legal next and how to invoke each (`nextActions`). Every
member is optional, and a member that does not apply to the scheme is omitted. The member names are generic so that
the extension can be renamed by changing one string.

The extension judges nothing. The buyer, or an evaluator the buyer names, applies the predicate to the delivery and
decides; the network enforces the transitions and the clocks. No program reads the extension, and no program,
timekeeper, facilitator or resource server evaluates a delivery on its account.

## Where it travels

| Carrier | Member | Content |
| --- | --- | --- |
| `PaymentRequired` (the 402) | `extensions.escro` | `info`, the object this document defines, and `schema`, the JSON Schema `{"$ref": "<URI>"}`, where `<URI>` is the published URI of the schema for the version the server implements (Schema reference). x402 V2 requires a `schema` beside every extension's `info`; the reference is that schema. |
| `PaymentPayload` | `extensions.escro` | The client echoes the 402's member unchanged. x402 lets a client append to `info`; this extension defines no member a client adds. |
| `SettlementResponse` (`PAYMENT-RESPONSE`) | `extensions.escro` | `info` only, mirrored: `acceptance`, `receipt` and `settlement` equal the 402's; `nextActions` lists the steps legal after this settlement. The receiver validates it with the schema it holds. |
| `/supported` | `extensions` | A facilitator that implements the extension lists `"escro"`. |

The extension uses no `EXTENSION-RESPONSES` sidechannel entry.

A client validates `info` against the schema it holds for the version it implements, never against the `schema` a 402
carries, and never fetches a schema to decide whether to pay. Every object the schema defines is closed except `args`,
which is free-form: its members are the step's own. A later version that adds a member ships a schema that declares it.
A client whose validation of `info` fails, including on a member of a version it does not implement, skips the accept
entry the extension describes (the `on-delivery` entry), not the whole 402: an `exact` entry beside it is unaffected.

### Schema reference

Each version's schema is published at `https://escro.ai/schemas/escro-extension/<version>.json`, which is also the
file's `$id`, and the bytes served at a version's URI never change: a schema that changes is a new version at a new
URI. This document states the SHA-256 of the UTF-8 bytes of the schema's JCS form; a client that obtains the file by
any route (this repository, a package, the URI) checks that hash before it holds the file, and a validator resolves
the `$ref` from a held copy registered under its `$id`, never by fetching it while validating. A server carries
`{"$ref": "<URI>"}` as the extension's `schema`. A client accepts a 402 whose `schema` is a reference, an inline
schema (the form of version 0.3) or any other object, since it validates with the schema it holds; the reference
names the version the server describes and grants nothing. A server accepts a payment whose echoed `extensions.escro`
carries either form.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `acceptance` | object | The predicate the judge will apply to the delivery. |
| `receipt` | object | Where, and in what format, the outcome will be attested. |
| `settlement` | object | The settlement terms: the review window, what silence after it does, who bears the fee. |
| `nextActions` | array | The steps legal from the job's current state, each with the channel that invokes it. |

### `acceptance`

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `name` | yes | string, lowercase words joined by `-`, at most 64 characters | The predicate. No colon, so the name never splits the decision memo. |
| `paramsHash` | yes | 64 lowercase hex characters | SHA-256 of the UTF-8 bytes of the predicate's parameters in the JSON Canonicalization Scheme (JCS, RFC 8785). |
| `fixtureHashes` | no | array of 64 lowercase hex characters, no duplicates | SHA-256 of each fixture file the predicate was tested against, over the file's bytes. Absent means none. |

The server proposes the predicate in the 402; the buyer accepts it by funding, or skips the entry. The parameters and
the fixtures travel out of band: on `on-delivery`, inside the job specification the scheme commits to (`specUri`, for
example under `metadata`), so `specHash` binds them too. The judge applies the named predicate with parameters whose
canonical JSON hashes to `paramsHash`. A client that does not implement `name`, or cannot obtain parameters matching
`paramsHash`, skips the entry before it funds anything.

A predicate is the judge's tool. It runs where the judge runs, on the buyer's side; a predicate that calls a language
model (`llm-rubric`) is the buyer's model, run by the buyer, never the program's or the timekeeper's.

`acceptance` names the predicate and binds its parameters by hash; it is not a registration of the rule. Where a job's
acceptance criteria are registered on chain before any evidence exists, the extension cites ERC-8412 rather than
defining a registration of its own (Preregistered acceptance).

#### Predicate catalogue

The reference catalogue. Each predicate's parameters and its pass condition are defined where it is implemented
(Escro's SDK predicate library implements these names), not here; the second column is informative. `name` is not an
enum in the schema: a buyer and a worker may agree on a predicate outside this list, and a client refuses a name it
does not implement before it funds, so an open vocabulary costs no safety.

| Name | Checks, informally |
| --- | --- |
| `hash-matches` | The SHA-256 of the delivered bytes equals the hash the parameters give. |
| `tests-pass` | A test suite named by the parameters passes against the delivery. |
| `json-schema` | The delivery is JSON that validates against the schema the parameters give. |
| `file-format` | The delivery is a file of the declared type, within the declared bounds. |
| `pod-receipt` | A proof-of-delivery receipt for the delivery verifies under the key the parameters name. |
| `llm-rubric` | A model the buyer runs grades the delivery against the rubric in the parameters at or above a threshold. |
| `ci-check` | A named continuous-integration check reports success for the delivered revision. |
| `period-sla` | A service delivered over a period met the bounds the parameters set for it. |
| `attestation-valid` | An attestation over the delivery (a signed enclave report or a proof) verifies. |

### `receipt`

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `schema` | yes | printable ASCII, no spaces, at most 128 characters | The format the outcome is attested in. This document defines `escro/receipt/2`: the decision record, naming its job (Decision record). |
| `verifierUrl` | no | `https:` URL, no query, fragment or trailing `/` | Where the attested outcome of a job can be fetched (Fetching a record). The reader trusts nothing from it that it cannot recompute: the record's hash must equal the memo or the `reason` on chain, and the record's deliverable hash the commitment the network holds. |

### `settlement`

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `reviewWindowSeconds` | yes | integer, at least 1 | The length of the review window, in seconds from submission. |
| `settlementMode` | yes | `"release"` \| `"refund"` | What silence after the review window does: `release` pays the worker, `refund` returns the funds to the buyer. |
| `feePayer` | yes | `"client"` \| `"worker"` | Which party bears the escrow operator's fee: `client` deposits it on top of the amount, `worker` has it deducted on release. |

The names and meanings are the `on-delivery` grammar's (Wire fields). Where a scheme carries the same terms in an
accept entry's `extra`, as `on-delivery` does, the two must be equal, and a client that finds them different skips the
entry; when a 402 offers entries with different terms, the server omits `settlement`. The Solana binding offers
`86400`, `"release"` and `"client"` today; `refund` is offered from a future account layout, and a client that cannot
accept the advertised mode skips the entry. When `settlement` is absent the scheme's own terms govern.

### `nextActions`

Each entry is one step: what it does, who may take it, and how to invoke it. The list is a description, not an
authority: the network refuses a step that is not legal, whatever the list says.

| Field | Channel | Required | Meaning |
| --- | --- | --- | --- |
| `action` | all | yes | The step, from the vocabulary below. |
| `actor` | all | yes | Who may take it: `buyer`, `worker`, `judge`, `timekeeper`, `arbitrator` or `anyone` (the `on-delivery` roles). |
| `channel` | all | yes | `onchain`, `server` or `mcp`. |
| `notBefore` | all | no | Unix seconds before which the step is not yet legal. |
| `network` | `onchain` | yes | The CAIP-2 network the step is sent on. |
| `instruction` | `onchain` | yes | The program instruction or contract function. |
| `address` | `onchain` | no | The job's on-chain address, once it exists. |
| `args` | `onchain`, `mcp` | no | Arguments the reader cannot derive itself, as an object. |
| `method` | `server` | yes | `GET` or `POST`. |
| `url` | `server` | yes | The `https:` URL the request goes to. |
| `server` | `mcp` | yes | The MCP server that offers the tool: a package name or an `https:` URL. |
| `tool` | `mcp` | yes | The MCP tool name. |

#### Actions

| `action` | Grammar transition | On the Solana binding |
| --- | --- | --- |
| `fund` | none to funded | `create_escrow` |
| `claim` | funded to claimed | `claim_task` |
| `submit` | claimed to submitted | `submit_deliverable` |
| `poll` | none; reads the job | the `poll` URL, with a payload re-signed by the buyer |
| `release` | submitted to released; disputed to released, by the arbitrator | `release_payment` (buyer), `timeout_release` (timekeeper), `arbitration_release` (arbitrator) |
| `dispute` | claimed or submitted to disputed | `raise_dispute` |
| `cancel` | funded to refunded, by the buyer | `cancel_escrow` |
| `refund` | funded or claimed to refunded, after the deadline; disputed to refunded, by the arbitrator | `refund_buyer` (anyone, after the deadline and grace), `arbitration_refund` (arbitrator) |

An `onchain` step is sent to the program or contract that the accept entry for the same `network` names; the
extension never carries a program address and never a transaction to sign. The client builds every transaction itself,
from the program it already trusts for that network.

## Examples

### A 402 offering `on-delivery` with the extension

The Solana binding's 402, with the extension. The buyer funds through its own `create_escrow`, or through an MCP
server's tool:

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
  ],
  "extensions": {
    "escro": {
      "info": {
        "acceptance": {
          "name": "json-schema",
          "paramsHash": "9e30b466ac491380429e9687611e33970f253e264fa1a08b82707f12047fbfc9",
          "fixtureHashes": [
            "cfc463963edece607039edd3aa94494671a92b2ef4cbdf6c341e5494c15ceab0",
            "532cd54dde3ec75930c4adfef3598015919b754932425ced364846e16ace8181"
          ]
        },
        "receipt": {
          "schema": "escro/receipt/2",
          "verifierUrl": "https://worker.example.com/v1/receipts"
        },
        "settlement": {
          "reviewWindowSeconds": 86400,
          "settlementMode": "release",
          "feePayer": "client"
        },
        "nextActions": [
          {
            "action": "fund",
            "actor": "buyer",
            "channel": "onchain",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "instruction": "create_escrow"
          },
          {
            "action": "fund",
            "actor": "buyer",
            "channel": "mcp",
            "server": "@escro/mcp",
            "tool": "create_escrow"
          }
        ]
      },
      "schema": { "$ref": "https://escro.ai/schemas/escro-extension/0.4.json" }
    }
  }
}
```

### The mirror on the claim's settlement response

After the server's claim lands, its `PAYMENT-RESPONSE` repeats the terms and lists what each party may do next while
the work runs:

```json
{
  "success": true,
  "transaction": "55ZKgwhRv87nEsKBZCSrRT753oLAHF5Fur84219ahsBPBbqEjfEj8TFBiEp4GnACaAtffwEbURqQ23sb3Q5shwDt",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "3WvsPQFigdnkBkfj4uHqV5N5mxkV3mRXm7oCMP3knLfV",
  "extensions": {
    "escro": {
      "info": {
        "acceptance": {
          "name": "json-schema",
          "paramsHash": "9e30b466ac491380429e9687611e33970f253e264fa1a08b82707f12047fbfc9",
          "fixtureHashes": [
            "cfc463963edece607039edd3aa94494671a92b2ef4cbdf6c341e5494c15ceab0",
            "532cd54dde3ec75930c4adfef3598015919b754932425ced364846e16ace8181"
          ]
        },
        "receipt": {
          "schema": "escro/receipt/2",
          "verifierUrl": "https://worker.example.com/v1/receipts"
        },
        "settlement": {
          "reviewWindowSeconds": 86400,
          "settlementMode": "release",
          "feePayer": "client"
        },
        "nextActions": [
          {
            "action": "poll",
            "actor": "buyer",
            "channel": "server",
            "method": "GET",
            "url": "https://worker.example.com/v1/jobs/FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
          },
          {
            "action": "submit",
            "actor": "worker",
            "channel": "onchain",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "instruction": "submit_deliverable",
            "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
          },
          {
            "action": "dispute",
            "actor": "buyer",
            "channel": "onchain",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "instruction": "raise_dispute",
            "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
          },
          {
            "action": "refund",
            "actor": "anyone",
            "channel": "onchain",
            "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "instruction": "refund_buyer",
            "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA",
            "notBefore": 1795000901
          }
        ]
      }
    }
  }
}
```

### The same object after submission

Once the worker has submitted, the legal steps change: the buyer releases or disputes, and from the end of the review
window the timekeeper may release. A server may serve this object beside a poll result:

```json
{
  "acceptance": {
    "name": "json-schema",
    "paramsHash": "9e30b466ac491380429e9687611e33970f253e264fa1a08b82707f12047fbfc9",
    "fixtureHashes": [
      "cfc463963edece607039edd3aa94494671a92b2ef4cbdf6c341e5494c15ceab0",
      "532cd54dde3ec75930c4adfef3598015919b754932425ced364846e16ace8181"
    ]
  },
  "receipt": {
    "schema": "escro/receipt/2",
    "verifierUrl": "https://worker.example.com/v1/receipts"
  },
  "settlement": {
    "reviewWindowSeconds": 86400,
    "settlementMode": "release",
    "feePayer": "client"
  },
  "nextActions": [
    {
      "action": "release",
      "actor": "buyer",
      "channel": "onchain",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "instruction": "release_payment",
      "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
    },
    {
      "action": "release",
      "actor": "buyer",
      "channel": "mcp",
      "server": "@escro/mcp",
      "tool": "release_payment",
      "args": {
        "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
      }
    },
    {
      "action": "dispute",
      "actor": "buyer",
      "channel": "onchain",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "instruction": "raise_dispute",
      "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA"
    },
    {
      "action": "release",
      "actor": "timekeeper",
      "channel": "onchain",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "instruction": "timeout_release",
      "address": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA",
      "notBefore": 1795084400
    }
  ]
}
```

## Decision record

The judge records its decision as a decision record and hashes it; the hash travels where the network can carry it,
and the record itself at the receipt's `verifierUrl`, so that anyone can recompute the hash and re-run the predicate.

| Field | Type | Meaning |
| --- | --- | --- |
| `acceptance` | object | The `acceptance` object, exactly as the 402 advertised it. |
| `decision` | `"pass"` \| `"fail"` | The predicate's outcome as the judge applied it. |
| `deliverableHash` | 64 lowercase hex characters, no `0x` prefix | The lowercase hex SHA-256 of the delivered bytes, as the binding commits it: the same string as the Solana binding's `deliverable_hash`, and on ERC-8183 the `deliverable` without its `0x` prefix. |
| `job` | object | The job the record decides: its network, the contract that holds it and its identifier there (`job`). The same acceptance and the same bytes on two jobs give two records and two hashes. |

The record covers the hash of the delivered bytes and nothing else the worker submits: the Solana binding's
`proof_uri` is a pointer to where the bytes can be fetched, not the work, and stays out of the record.

For the job in the examples above, the escrow `FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA` on Solana mainnet:

```json
{
  "acceptance": {
    "name": "json-schema",
    "paramsHash": "9e30b466ac491380429e9687611e33970f253e264fa1a08b82707f12047fbfc9",
    "fixtureHashes": [
      "cfc463963edece607039edd3aa94494671a92b2ef4cbdf6c341e5494c15ceab0",
      "532cd54dde3ec75930c4adfef3598015919b754932425ced364846e16ace8181"
    ]
  },
  "decision": "pass",
  "deliverableHash": "be707fc3d88209b8d345ef3f433439ca5f9e7f709459841490ddaec7aff3f642",
  "job": {
    "id": "FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "program": "4CwLNRF4mFXutiBGjtMHQBxh8whW8T8EyvJXdRhY1rvr"
  }
}
```

The memo is `escro:predicate:<name>:<decision>:<hash>`, where `<hash>` is the lowercase hex SHA-256 of the UTF-8 bytes
of the record in JCS. For the record above:

```text
escro:predicate:json-schema:pass:4a52c12111ddf479acfd4d9cb4181d35ead5320312e4c887ef37456769ba91d6
```

On Solana the judge adds the memo as a Memo-program instruction to its `release_payment` transaction on a pass, and
may add it to its `raise_dispute` transaction on a fail. The program never reads it: a memo is the judge's statement
of which rule it applied and what it found, not a proof that it ran the rule. Anyone holding the record, the
parameters and the delivered bytes can check the hash against the memo and run the predicate again.

A record carries no signature; a later version that defines one signs the record's hash in an envelope beside the
record, so the record and its hash are unchanged.

### `job`

| Field | Type | Meaning |
| --- | --- | --- |
| `network` | string | The network the job lives on, as a CAIP-2 identifier: on Solana `solana:` and the 32-character base58 reference; on ERC-8183 `eip155:` and the chain id in decimal, with no leading zero. No other namespace is defined. |
| `program` | string | The contract that holds the job: on Solana the program id in base58; on ERC-8183 the contract address as `0x` and 40 lowercase hex characters. |
| `id` | string | The job within that contract: on Solana the escrow account's address in base58; on ERC-8183 the `jobId` in decimal with no leading zero, written as a string, never a JSON number. |

Each value has one written form, so one job gives one record and one hash. On Solana, `program` and `id` each decode
from base58 to exactly 32 bytes and re-encode to the same text: a string that decodes to another length, as one with
an added leading `1` does, names no key and is refused. A record with no `job`, the form of version 0.1, is refused.

### Fetching a record

`GET <verifierUrl>/<job.id>` returns the job's decision record as JSON (`application/json`): the record the judge
hashed, in any serialisation of the same object, since the hash is taken over its JCS form. It answers 404 while no
decision is recorded. `<job.id>` is the record's `job.id`: the escrow account's base58 address on Solana (the `address`
a `nextActions` step carries), the `jobId` in decimal on ERC-8183. For the job in the examples above, the record is
served at:

```text
https://worker.example.com/v1/receipts/FVoa39NMiWHzWNFJG7PyP5JN7Qo4ZE4ujy96xJ9AGjhA
```

A reader refuses a fetched record whose `job` is not the job it requested: another `id`, `program` or `network`. Since
the path carries only `job.id`, one `verifierUrl` serving jobs of two ERC-8183 contracts or chains can return a record
whose `program` or `network` is not the reader's, and the reader refuses it deterministically by that comparison.

## ERC-8183

The envelope maps onto ERC-8183 (Draft, https://eips.ethereum.org/EIPS/eip-8183) without changing the base contract,
as a companion convention for `description` and `reason`.

| ERC-8183 | `escro` | Rule |
| --- | --- | --- |
| `description` (set at job creation) | `acceptance` | The JCS text of `{"acceptance": <the acceptance object>}`. A deployment that also commits the job brief's hash adds it beside `acceptance` as `specHash`, a string of 64 lowercase hex characters with no `0x` prefix, as the Solana binding writes it. A job whose acceptance criteria are preregistered under ERC-8412 adds `preregistrationId` beside `acceptance`: the id its registry's `preregister` returned, as `0x` and 64 lowercase hex characters. |
| `evaluator` | the judge | The client itself, or the evaluator the client names; `acceptance` is the rule it will apply. |
| `deliverable` (`bytes32`, at submission) | `deliverableHash` | The provider submits the SHA-256 of the delivered bytes as `deliverable`; the decision record writes it as 64 lowercase hex characters without the `0x` prefix. |
| `reason` (`bytes32`, on `complete` and `reject`) | the decision record | keccak256 of the UTF-8 bytes of the record, `job` included, in JCS, with `decision` `pass` on `complete` and `fail` on `reject`. The same bytes give the SHA-256 memo, so one record serves both. |
| `budget`, fees | `settlement.feePayer` | The `job-escrow` EVM draft deducts fees from the provider's payout: `feePayer: "worker"`. |
| `expiredAt`, the evaluation grace | `settlement.reviewWindowSeconds`, `settlement.settlementMode` | ERC-8183's text refunds an unevaluated submitted job after expiry (`refund`); settle-on-silence deployments pay the provider (`release`). The review window is the time a submitted job is protected from expiry. |
| `expiredAt`, ERC-8412 `expiry` | `preregistrationId`, `settlement.reviewWindowSeconds` | A job tied to a preregistration has `expiredAt` plus the review window no later than the preregistration's `expiry`, and its evaluator decides it no later than `expiry`. A preregistration resolved `ExpiredUnresolved` is non-satisfaction (ERC-8412 section 9): no release rests on it. |
| `fund`, `submit`, `complete`, `reject`, `claimRefund` | `nextActions` | `onchain` steps naming these functions: `fund`, `submit`, `release` (`complete`), `refund` by the `judge` (`reject`) and `refund` by `anyone` after expiry (`claimRefund`). |

The receipt's `verifierUrl` serves the decision record, so a reader can recompute `reason` from the record and check
it against the `reason` the job's completion or rejection recorded on chain.

An illustrative record for a job rejected on an ERC-8183 contract on chain 8453; its `job` names the chain, the
contract and the `jobId`:

```json
{
  "acceptance": {
    "name": "json-schema",
    "paramsHash": "9e30b466ac491380429e9687611e33970f253e264fa1a08b82707f12047fbfc9",
    "fixtureHashes": [
      "cfc463963edece607039edd3aa94494671a92b2ef4cbdf6c341e5494c15ceab0",
      "532cd54dde3ec75930c4adfef3598015919b754932425ced364846e16ace8181"
    ]
  },
  "decision": "fail",
  "deliverableHash": "be707fc3d88209b8d345ef3f433439ca5f9e7f709459841490ddaec7aff3f642",
  "job": {
    "id": "42",
    "network": "eip155:8453",
    "program": "0x1111111111111111111111111111111111111111"
  }
}
```

### Preregistered acceptance (ERC-8412)

The extension defines no format for registering an acceptance rule before the work. A job whose acceptance criteria
are frozen on chain before any evidence exists uses ERC-8412 (Preregistered Acceptance Criteria, Draft,
https://github.com/ethereum/ERCs/pull/2002): the criteria author registers the digest of its criteria document (ERC-8412
section 2) through the registry's `preregister`, which returns the `preregistrationId`, and the verifier later records
its itemized verdict with `attestOutcome` (section 6). Two rules bind an ERC-8183 job to its preregistration:

1. The job's terms carry the preregistration id: its `description` holds `preregistrationId` beside `acceptance`.
2. The job's `expiredAt` may not fall after the preregistration's `expiry`, as `getPreregistration` returns it, and
   neither may the end of the deployment's evaluation grace: `expiredAt` plus `settlement.reviewWindowSeconds` is no
   later than `expiry`.

The evaluator decides the job, by `complete` or `reject`, no later than `expiry`. ERC-8183's `complete` checks no time,
and the review window keeps a submitted job open past `expiredAt`, so without this rule an evaluator could decide after
`expiry`, when the registry refuses the verifier's `attestOutcome` (ERC-8412 E7). A preregistration resolved
`ExpiredUnresolved` (E8) is non-satisfaction (ERC-8412 section 9): the evaluator does not `complete` a job on it.

The party that did not write the terms checks both rules against the registry it trusts for that network before it
commits: the provider skips a job that breaks either before it does the work, and a client handed terms someone else
drafted skips it before it funds. Neither the registry nor the extension judges the work: the registry refuses a verdict
only on mechanical grounds (the wrong signer, E3; after `expiry`, E7; a `None` or `ExpiredUnresolved` verdict, E9; a
second attestation or one on a resolved or superseded preregistration, E3, E10 and E13; outcomes of the wrong length or
inconsistent with the verdict or the registered `required` and `waivable` flags, E2, E4 to E6 and E11) and never weighs
the evidence. The evaluator decides, as without a preregistration.

ERC-8412 section 10 offers an optional ERC-8183 binding in which `deliverable` MAY be the `bundleDigest` and `reason`
MAY be the `attestationDigest`. This extension's mapping differs: `deliverable` is the SHA-256 of the delivered bytes
and `reason` stays the keccak256 of the decision record.

## Security considerations

- **A carried schema or reference.** A server chooses the `schema` it carries, and the host of a URI the bytes it
  serves. A client validates against the schema it holds, pinned by the hash this document states; a reference to
  another URI, or other bytes at the URI, changes nothing a conforming client checks.
- **Terms that disagree.** A `settlement` that differs from the accept entry's `extra` makes the entry ambiguous; the
  client skips it.
- **Steps are not authority.** `nextActions` names steps and carries no program address and no transaction. A client
  that built a transaction from the list would still send it to the program it trusts, and the network refuses an
  illegal step.
- **Parameter substitution.** `paramsHash` and `fixtureHashes` bind the parameters and the fixtures before funding; a
  judge handed different parameters after funding detects it by hashing them.
- **A record carried to another job.** A record names its job, so a record carried to another job, another contract or
  another network is refused by a verifier that compares its `job` with the job it settles.
- **A reused escrow address.** On Solana the escrow's address derives from the buyer and the task id, so a buyer that
  re-creates an escrow with the same task id after the first one closed reuses the address, and a record for the first
  names the second. A client SHOULD never reuse a task id for one buyer.
- **A memo is a claim.** It states which predicate the judge applied and its outcome. Its value is that anyone can
  re-run the predicate on the disclosed parameters and the delivered bytes and compare.
- **No quality judgement.** The extension adds no judge. The buyer, or the evaluator it names, decides; the program
  and the timekeeper evaluate no delivery.

## Version history

| Version | Date | Changes |
| --- | --- | --- |
| 0.1 | 2026-11-07 | Initial draft. |
| 0.2 | 2026-11-12 | The decision record names its job (`job`: network, program, id); the receipt format is `escro/receipt/2`; a 0.1 record, with no `job`, is refused. |
| 0.3 | 2026-11-12 | The acceptance rule's registration cites ERC-8412 rather than defining its own; on ERC-8183 a job's terms carry its `preregistrationId`, its `expiredAt` plus the review window is not later than the preregistration's `expiry`, its evaluator decides it by `expiry`, and a preregistration resolved `ExpiredUnresolved` is non-satisfaction. |
| 0.4 | 2026-11-13 | The 402 carries the schema by reference: `schema` is `{"$ref": <the version's published URI>}`; the schema is published at `https://escro.ai/schemas/escro-extension/0.4.json`, with the SHA-256 of its JCS form stated here; a client accepts the reference or an inline schema, and a server either form in an echo. |
