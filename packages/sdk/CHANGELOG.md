# Changelog

## 0.5.0

### Breaking

- `pay({ to, amountMicroUsdc })` with neither `paymentRequired` nor `url` rejects with
  `EscroPayError` `no_offer`, not `EscroRailNotEnabledError`.
- `createEscrow` on a `"mainnet"` client constructed without the new `spendCap` option throws an
  `EscroError` with code `SPEND_CAP_REQUIRED` before any request. Construction is unchanged: a
  worker-only mainnet client needs no cap.
- `createEscrow` refuses an `assignedWorker` that is not a base-58 public key, or an
  `amountUsdc` that is not a positive whole number: an `EscroError` with code
  `VALIDATION_ERROR`, before any request.
- The create request (`POST /v1/escrows`) is abandoned after 15 s with an `EscroError` with code
  `API_TIMEOUT`.
- `EscrowErrorCode` gains `ESCROW_PDA_REUSED`: the API answers it
  when a confirmed transaction acts on a later lifecycle of the escrow's PDA, and
  `Escro.confirm` throws it as an `EscroConfirmError` without retrying. Code that switches over
  every `EscrowErrorCode` needs the new case. `ESCROW_NOT_SETTLED` (no settlement of the escrow
  recorded or listed yet) and `TX_NOT_FOUND` (the transaction cannot be recorded yet) keep their
  names and stay retried, with the wider meanings their doc comments state.
- `ZkmlProofAutoReleaseOptions`: `resolveProofUri` is added and required; `fetchContent` and
  `fetchProof` are removed (the content now comes from the pinned bundle).
- `ZkmlProofAutoReleaseOptions.modelCommitment` is required; `inputCommitment` is added and
  required. Construction without either, or without `resolveProofUri`, throws an `EscroError` with
  code `ADAPTER_CONFIG_ERROR`.
- `ZkmlExpectation.modelCommitment` is required; `inputCommitment` is added and required (affects
  `verifyZkmlProof`, `verifyZkmlProofUri` and any custom `verify`).
- `encodeZkmlProofUri` takes a `ZkmlProofBundle` (`{ content, proof }`) and returns the document
  to pin, not a `proofUri`.
- `decodeZkmlProofUri` takes the resolved document and returns `ZkmlProofBundle | null`.
- `verifyZkmlProofUri` takes the resolved document and also checks that the bundle's content
  hashes to the expected `contentHash`.
- `ZkmlAdapterConfig.pin` receives the bundle document string, not a `ZkmlProof`.
- `createZkmlAdapter`'s default `proofUri` is `ipfs://placeholder-<16 hex>` of the pinned
  document (it was a `zkml-proof:` URI holding the proof); the demo's `inputCommitment` is now
  `computeZkmlInputCommitment(spec)`.
- `createGensynAdapter`: `metadata.reeProof` is gone; `pin` receives the bundle document
  (`encodeGensynBundle({ content, proof })`), so `proofUri` names `{ content, proof }`, not the
  bare content.
- `assertServiceAdapterContract` reports a `proofUri` the API's submit build refuses: a scheme
  other than http(s), ipfs or ar, or more than 128 UTF-8 bytes.
- The API refuses a `proofUri` over 128 UTF-8 bytes (the on-chain `proof_uri` allocation);
  `submitDeliverable` rejects with an `EscroError` carrying the API's `VALIDATION_ERROR`.
- Every method that puts an address in a request path or query refuses an address that is not a base-58 public key
  with an `EscroError` with code `VALIDATION_ERROR` and the message `<param> must be a base-58 public key`, before any
  request, RPC read or signature; the message never repeats the value. On `ApiClient`: `getEscrow`, `claimTask`,
  `submitDeliverable`, `releasePaymentDb`, `cancelEscrow`, `raiseDispute`, `confirm` (`address`), `getReputation`
  (`wallet`), `getOutstandingDeposits` (`maker`) and `listEscrows` (`assignedTo`, `maker`, `taker`). On `Escro`, every
  method that takes an escrow address, `releaseWithPredicate` before its decision check and its chain read, and
  `confirm` with the plain `EscroError`, not `EscroConfirmError`. A canonical key is sent and signed byte for byte as
  before.
- `getReputation` with a non-key answered zeroed components and now throws.
- `listEscrows` with an `assignedTo`, `maker` or `taker` of `""` (or `null` from JavaScript) returned the unfiltered
  list and now throws; a filter that is absent or `undefined` is still left out.
- `getEscrow(<non-key>, { poll: true })` polled until `EscrowTimeoutError` (24 h) and now throws at once.
- A non-string address from JavaScript, a `PublicKey` instance included, is refused: pass its `toBase58()`.
- Elsewhere the error class changes from `EscrowNotFoundError`, `EscroConfirmError`, `TypeError` or `EscroError`
  `UNKNOWN` to `EscroError` `VALIDATION_ERROR`; `listEscrows` and `getOutstandingDeposits` with a non-empty non-key
  already threw `VALIDATION_ERROR` (from the API) and now send no request.
- A decision record names the job it decides (the `escro` extension 0.2, receipt format `escro/receipt/2`):
  `DecisionRecord` gains a required `job: { network, program, id }`, and `PredicateCheck` a required `job`, which
  `runPredicate` copies into the record and refuses (`PredicateRecordError`) when absent or malformed. A 0.1 record,
  with no `job`, is refused by `decisionRecordHash`, `predicateMemo` and `releaseWithPredicate` (`PREDICATE_RECORD`).
- `releaseWithPredicate` refuses, before any chain read or signature, a record whose `job` names another network
  (`PREDICATE_NETWORK_MISMATCH`), another program (`PREDICATE_PROGRAM_MISMATCH`) or another escrow
  (`PREDICATE_JOB_MISMATCH`) than its own cluster and `address`.

### Added

- The pay guards a surface applies before it lets an agent call `pay()`: `isPublicAddress`
  (an IPv4 or IPv6 literal outside the loopback, link-local, private and otherwise non-public
  set), `payUrlRefusal` (whether a URL's host may be paid on a cluster, with the operator's
  opt-in for private hosts and a resolver the caller passes; `PayUrlRefusal`, `HostLookup`) and
  `deadlineBoundedPolicy` (a `PayPolicy` choosing what `pay()` would, refusing an escrow entry
  whose deadline is past now plus a bound), and `payAddressRule` (the address rule such a surface
  passes `pay()`).
- `PayParams.admitAddress`: given, `pay()` resolves each host it requests (the 402's resource and,
  on the escrow rail, the job specification's host) once per call, puts every answer to the rule,
  and connects only to the answers it admitted, over `node:http` or `node:https` with TLS checked
  against the URL's name. A refused answer is `EscroPayError` `host` (`detail` `address`, or
  `unresolved` for a host that does not resolve), and on the spec host `OnDeliveryFundError`
  `spec_host`; both precede any signature or create. `fetchTaskSpec` and `fundFromAccept` take the
  same rule for the spec host. Without it `pay()` sends over `fetch` as before.
- `pay()` refuses a `request.headers` that is not a plain object record (a `Headers`, an array, a
  `Map`, an iterable object) as `request_header` `not_record`, and judges `PAYMENT-SIGNATURE` on
  the one copy of the headers it sends.
- `pay()` pays an x402 V2 402: `url`, which the SDK requests for its 402, or `paymentRequired`, a
  402 the caller already decoded. Only an entry paying exactly `amountMicroUsdc` to `to` on the
  client's cluster is paid; an `on-delivery` (or `job-escrow`) entry is funded through
  `createEscrow` (its spend cap unchanged) by `parseEscrowAccept` and `fundFromAccept`, and the
  payment is presented once to the URL that answered the 402, with no redirect followed and
  nothing retried. `PayParams` gains the optional `paymentRequired`, `url`, `request`
  (`PayRequest`), `policy` (`PayPolicy`, which can only narrow the choice) and `admitAcceptance`;
  `PaymentResult` gains the optional `escrow` (the escrow PDA), `settlement` (the decoded
  `PAYMENT-RESPONSE`) and `response`; `TxShape` gains the optional `accept` and `scheme`. The
  first request is bounded by 30 s, the paid request by the entry's `maxTimeoutSeconds`, and an
  entry over 3600 seconds is not paid. A network failure of the first request rejects `EscroError`
  `NETWORK_ERROR`, with nothing funded. `EscroPayError` (code `PAY_REFUSED`, `reason` a
  `PayRefusal`) reports `pay()`'s refusals; one after the create carries `escrowPda` and
  `createSignature` for `cancelEscrow`. An `exact` or `upto` entry rejects with
  `EscroRailNotEnabledError("x402")`; `ENABLED_RAILS` is unchanged.
- `EscrowPaymentRouter.selectRail` routes a scheme: `on-delivery` and `job-escrow` to `escrow`
  under `async`, `exact` and `upto` to `x402` under `sync`. A mode that is not the scheme's, or a
  `scheme` that differs from `accept.scheme`, throws `EscroPayError` `scheme_conflict`; any other
  scheme `unsupported_scheme`; an `exact` or `upto` scheme `EscroRailNotEnabledError("x402")`.
- The `spendCap` constructor option (`SpendCap`): `{ maxOutstandingMicroUsdc, outstanding? }`,
  copied at construction. With it, `createEscrow` reads the on-chain fee rate and the wallet's open
  deposits from one `GET /v1/escrows/outstanding?maker=` (FUNDED, IN_PROGRESS, SUBMITTED, DISPUTED;
  amount plus fee each), adds the process's creates still in flight, and throws `SPEND_CAP_EXCEEDED`
  for a create whose deposit would pass the cap, before the create is sent. An outstanding read that
  fails, answers something malformed or takes longer than 15 s refuses the create with
  `SPEND_CAP_UNREADABLE` (a failed or timed-out read as its `cause`); an API without the route
  refuses every capped create. A PlatformConfig read that fails or takes longer than 15 s throws its
  own error, with no code. Every capped client for one wallet and cluster in a process shares one
  admission queue and one in-flight set. A create that throws before its transaction is sent holds
  nothing; once sent, it holds its deposit until a successful `confirm`, or until an RPC rejection
  other than "already processed" or `TX_FAILED` shows it never took effect. The fee is read inside
  the wallet's admission, after the creates admitted before it. An injected `spendCap.outstanding()`
  is called with its `spendCap` as `this` and bound like the API read: one that has not answered
  within 15 s is abandoned and the create refused with `SPEND_CAP_UNREADABLE`. The cap holds per
  process, not across processes.
- `ApiClient.getOutstandingDeposits(maker)`; `EscroError` takes an optional `{ cause }`.
- `assertWithinSpendCap`, the comparison `createEscrow` runs, for callers that check a cap
  themselves; `parseUsdc` reads a decimal USDC amount (`"12.5"`) as integer micro-USDC;
  `SPEND_CAP_ERROR_CODES`, the codes the spend cap throws (`required`, `exceeded`, `unreadable`).
- `ResolveProofUri`, the buyer's port that fetches what a `proofUri` names; a throw propagates and
  is never a verdict.
- `ZkmlProofBundle`, `computeZkmlInputCommitment` (the buyer's commitment over its own spec) and
  `ZKML_DEMO_MODEL_COMMITMENT`.
- `encodeGensynBundle`, `decodeGensynBundle` and `gensynProofAutoRelease`
  (`GensynProofAutoReleaseOptions`): a review policy that resolves `proofUri`, checks the bundle's
  content against `contentHash`, then releases only when `gensynAutoRelease` does.
- `MAX_PROOF_URI_BYTES` and `proofUriError` (the 128-byte proof URI cap and the check the API's
  submit build applies), so a worker can refuse an unfit storage endpoint before it claims.
- `getMyAssignedEscrows(state?, options?)`: every escrow assigned to the wallet in any served state
  (DISPUTED, COMPLETED and REFUNDED included) through `GET /v1/escrows?taker=`; `ApiClient.listEscrows`
  takes `taker`.
- x402 V2 `on-delivery`. The header codecs (`X402_HEADERS`, `encodePaymentRequired`,
  `decodePaymentRequired`, `encodePaymentSignature`, `decodePaymentSignature`,
  `encodePaymentResponse`, `decodePaymentResponse`, `X402CodecError`) and the wire types
  (`PaymentRequired`, `PaymentPayload`, `SettlementResponse`, `OnDeliveryAccept` and the `escro`
  extension's `EscroExtensionInfo`). A buyer reads PlatformConfig with `readPlatformConfig`, selects
  an entry with `parseEscrowAccept` (the cluster's network, program and mint, PlatformConfig's fee,
  `release` settlement, the buyer's own `maxDepositMicroUsdc` and optional `payTo` pin, the
  `escro` extension's terms and an `admitAcceptance` hook; `OnDeliveryAcceptError` lists each
  entry's refusal), and funds it once with `fundFromAccept`, which fetches the job specification
  (`fetchTaskSpec`: https only, no redirect, 10 s, 256 KiB), checks its hash, calls `createEscrow`
  with `payTo` as the assigned worker and returns the `PAYMENT-SIGNATURE` payload signed by the
  buyer (`buyerMessage`, `signEscrowPayload`; `OnDeliveryFundError`). A worker builds its entry with
  `buildEscrowAccept` and checks a payload over RPC with `verifyEscrowPayload` (or
  `verifyBuyerPresentation` for a poll), recording each accepted presentation in a `ReplayStore` it
  supplies (`memoryReplayStore` for one process). Both verifiers throw `EscroError`
  `VALIDATION_ERROR` before any work when `ctx.replay` is missing or `ctx.resourceUrl` is not an
  absolute http: or https: URL (a framework's request path is not one); `parseEscrowAccept` throws
  it when `maxDepositMicroUsdc` is not a bigint.
- `computeTaskSpecHash` (the `specHash` of a job specification) and `ONCHAIN_REFUND_GRACE_SECONDS`,
  re-exported from the root for a worker that builds its own `on-delivery` entries.
- `predicateJob(cluster, address)` builds a record's `job` from the cluster's CAIP-2 network and program id and the
  escrow's address; `DecisionJob` is its type.
- `pay()` pays an `exact` 402 entry over the x402 rail from the bot's own wallet. `ENABLED_RAILS` is now
  `["escrow", "x402"]`. Without a `policy`, `pay()` stays on the escrow rail when an `on-delivery` or `job-escrow`
  entry matches the caller's terms, whatever the 402's order. `upto` is refused (`unsupported_scheme`).
- `x402SpendCap` option: a per-process, per-wallet budget for the x402 rail, resetting on restart, with an injectable
  `spent()` reader. An `exact` payment on `"mainnet"` refuses without it (`SPEND_CAP_REQUIRED`).
- An error from `createEscrow` after its transaction may have landed carries own string properties `escrowPda` and
  `signature`, on the original error object.
- `EscroPayError` gains the reasons `requirements` and `transaction` and, on the x402 rail's post-signing refusals, a
  `payment` field (Memo text, amount, `payTo`).
- `EscroPayError.settlement` on a non-2xx paid answer: the `PAYMENT-RESPONSE` the worker sent beside the error
  status, decoded, whatever its `success`, when its `transaction` and `network` are strings. The refusal stays
  `presentation`, and the x402 cap hold stays.
- `buildBazaarDeclaration({ method, example, output })`: a route's x402 `bazaar` discovery
  declaration (`info.input` from the example request, `info.output` when given, and its Draft
  2020-12 `schema`), built without `@x402/extensions`, for `@escro/x402-middleware`'s `bazaar`. An
  `example` that is not a plain JSON object, or an empty `output.type`, throws. The types
  `BazaarDeclaration` and `BazaarHttpInput`, and `ResourceInfo`'s `serviceName`, `tags` and
  `iconUrl`.
- `createHttpFacilitator({ url, timeoutMs })`: a worker's x402 facilitator over HTTP, for
  `@escro/x402-middleware`'s `settleExact`. The URL must be `https:` with no username, password,
  query or fragment (a `TypeError` otherwise); the client loads on the first call. A refusal with a
  reason resolves as that answer; any other failure rejects `EscroFacilitatorError`
  (`FACILITATOR_UNAVAILABLE`, `operation`, `indeterminate` on `settle`), its message free of the URL.
- `buildExactAccept` (the worker's own `exact` entry: the cluster's USDC to `payTo`, the
  facilitator's fee payer; `ExactAcceptError` otherwise) and `exactFeePayer` (the fee payer a
  `/supported` answer names for `exact` on the cluster).
- The types `Facilitator`, `VerifyResponse`, `SupportedKind` and `SupportedResponse`;
  `SettlementResponse.amount`.
- `isBadPortUrl(url)`: whether an `http:` or `https:` URL's port (the scheme's default when it
  names none) is one the Fetch standard blocks, the same check `pay()` and the task-spec read
  apply, for a surface that fetches a URL itself.

### Changed

- `@escro/sdk` depends on `@x402/core`, `@x402/svm` and `@solana/kit` at exact versions, loaded on the first `exact`
  payment, and declares `engines.node >=22`.
- `EscroRailNotEnabledError` is now thrown when the x402 packages fail to load; its message no longer calls the rail
  reserved.
- An `exact` entry's `extra.memo` must be 1 to 32 bytes of printable ASCII, what the official client's fixed compute
  budget can land; any other memo is refused (`requirements`) before anything is signed.
- The `exact` refusal for an entry whose `asset` is not the cluster's USDC (`requirements`, `detail` `mint`) no longer
  repeats the 402's `asset`: its message is the fixed sentence `The entry's asset is not the cluster's USDC`, as every
  other `exact` requirement refusal already was.
- `RAILS_DOCS_URL`, linked from `EscroRailNotEnabledError` and the kit's rail refusal, is now `https://escro.ai/rails`.
- An `exact` payment's `PAYMENT-SIGNATURE` carries the 402's `extensions` exactly as received, as the `on-delivery`
  payment does, so a declaration such as `bazaar` reaches the facilitator. The header grows by the 402's
  `extensions`: a large one can push it past an 8 KB proxy header limit (see the header budget in
  `@escro/x402-middleware`'s README). A 402 whose `extensions` is present and not a JSON object is refused
  (`requirements`, `detail` `extensions`) before the payment is counted against the x402 cap or signed.
- A confirmation the RPC's status check reports failed now rejects with `EscroError` `TX_FAILED` once the failure is
  confirmed (dropping a create's spend-cap hold), and with an `Error` (no code) whose message names the signature and
  the failure at processed level when the status read sees it unseen or at processed. When the status read itself
  fails, it rejects with the `Error` a non-Error value gets, whose `cause` is the confirmation's value; the read's own
  error is not surfaced. A non-Error from the send rejects with an `Error` whose `cause` is the value.
- `PAY_MAX_DEADLINE_SECONDS` (604800, 7 days): the ceiling and default of the deadline bound of
  every agent-driven pay surface (`@escro/mcp`'s `pay_402`, the Solana Agent Kit plugin's
  `escro_pay_402`, `@escro/plugin-eliza`'s `PAY_402`), exported from the root.
- `deadlineBoundedPolicy` takes `escrowOnly` and `now`. With `escrowOnly: true` it never returns an
  `exact` or `upto` entry: where no escrow entry is on the terms it refuses with `EscroPayError`
  `no_eligible_entry`, detail `escrow_only`. Any value but `true`, `false` or absent is an
  `EscroError` `VALIDATION_ERROR` when the policy is built. `now` is the clock in milliseconds
  (default `Date.now`), read each time the policy runs; a reading that is not a whole number is an
  `EscroError` `VALIDATION_ERROR`.
- `deadlineBoundedPolicy` filters on devnet's network only for `cluster: "devnet"`, and on mainnet's
  for any other value, `undefined` included (it read every value but `"mainnet"` as devnet).

### Security

- `releasePayment` and `releasePaymentWithOutcome` sign a release only when every instruction
  beside it is one of the two idempotent associated-token-account creates the SDK builds: the
  escrow's worker's and the treasury's, for the PlatformConfig mint, paid by the wallet, each at
  most once. Anything else is refused with `UNEXPECTED_TRANSACTION` before signing.
- Under `spendCap`, a create the API answers with an escrow that one of the wallet's creates
  already has in flight is refused with `UNEXPECTED_TRANSACTION` before signing, so the
  in-flight deposit stays counted.
- `pay()` refuses a `url` (`url`), or with `paymentRequired` the 402's `resource.url` (`url`, `detail`
  `resource.url`), whose port is one the Fetch standard blocks (25, 6667 and the rest of its bad-port list, port 0 included), before any lookup, request,
  policy call, chain read, cap admission, signature or create, on both its transports.
- `fetchTaskSpec`, and the default job-specification read of `pay()` and `fundFromAccept`, refuse a `specUri` that
  carries a username or password, or names a port the Fetch standard blocks (`spec_fetch`), before any lookup or
  connection. No credential from a `specUri` is sent as `Authorization: Basic`.

### Fixed

- Polling (`getEscrow`, `getMyTasks` and `getMyEscrows` with `poll`) no longer throws on a `RATE_LIMITED`
  read: it waits the response's `retryAfterMs` (else the poll interval) and reads again within its
  deadline. Any other error still throws.
- `EscroRailNotEnabledError`'s message no longer names an internal phase, nor do the published
  type declarations.
- `zkmlProofAutoRelease` and `gensynProofAutoRelease` called with no options throw an `EscroError`
  with code `ADAPTER_CONFIG_ERROR` naming `resolveProofUri`, not a `TypeError`.

## 0.4.2

### Security

- The SDK signs a server-built transaction only when it is exactly the escro
  instruction the call requested: the instruction, escrow, acting signer, fee payer
  and, for a create, submit or dispute, its arguments (a create's amount, deadline,
  assigned worker, spec hash and the escrow derived from the wallet and task id).
  Anything else beside it, including a compute-budget instruction, is refused. A
  refusal throws an `EscroError` with code `UNEXPECTED_TRANSACTION`, before signing.
- `raiseDispute` refuses evidence whose URL scheme is not http(s), ipfs or ar (`VALIDATION_ERROR`),
  the same rule the API applies; it is checked before anything is sent.

### Changed

- `computeTaskSpecHash` (`@escro/shared`) hashes only the TaskSpec fields the API keeps, so a
  spec with extra keys hashes as the API records it. Specs without extra keys hash as before.

## 0.4.1

### Added

- `ProtocolStats` and `ActivityLeaderboard` carry top-level `cluster` and `usdcMint` (the
  API's cluster and its USDC mint, from config).

### Changed

- The API's volume figures read with six decimals on an empty table too (`"0.000000"`,
  not `"0"`). Both rate limiters answer 429 with one body: `error`, `code`
  `RATE_LIMITED` and `retryAfter`, the whole seconds `Retry-After` carries.

### Fixed

- A transaction that landed but failed at execution throws an `EscroError` with code
  `TX_FAILED`, naming the signature and the on-chain error; it returned the signature as if
  it had succeeded. `releasePayment` and `releasePaymentWithOutcome` throw it and never ask
  the API to record a failed release. `createEscrow`, `claimTask`, `submitDeliverable`,
  `cancelEscrow` and `raiseDispute` throw it before confirming, where they threw an
  `EscroConfirmError` with the API's `TX_FAILED`.

## 0.4.0

### Added

- `releasePaymentWithOutcome(address)` releases like `releasePayment` and reports whether
  the API recorded it: `{ signature, confirm: { landed: true } }`, or
  `{ signature, confirm: { landed: false, error } }` where `error` is an
  `EscroConfirmError` (`address`, `signature`, `code`: the API's code, or
  `NETWORK_ERROR` when the call never reached it). A failed confirm never throws: the
  release already landed on chain. New exported type `ReleasePaymentOutcome`.
- `getStats()`: the `operator` block of `ProtocolStats` carries the same five fields as the
  public figures (`totalEscrows`, `totalVolumeUsdc`, `settledVolumeUsdc`, `byState`,
  `activeEscrows`), over operator escrows only; it carried `totalEscrows` and
  `settledVolumeUsdc`.

### Changed

- The `@vitest/coverage-v8` development dependency is gone from the manifest (it moved to the
  repository root); the published dependencies are unchanged.
- Both `releasePayment` and `releasePaymentWithOutcome` retry the API record for up to
  30 s while the API refuses with `ESCROW_NOT_SETTLED` (its RPC still sees the escrow
  account) or a retryable confirm code. `releasePayment` routes through
  `releasePaymentWithOutcome`: it returns the signature and ignores a record that never
  landed.
- `ZkmlDeliverable`, `ZkmlReviewResult` and `ZkmlReviewPolicy` are type aliases of one
  review shape, the one the `create-escro-bot` buyer template now imports;
  `ZkmlReviewPolicy.evaluate` may return its `ZkmlReviewResult` synchronously or as a
  promise (it was promise-only). The fields are unchanged.
- `EscrowErrorCode` is now exactly the codes the API's route handlers send: `TASK_SPEC_NOT_FOUND`,
  `TASK_SPEC_INVALID`, `INVALID_SIGNATURE`, `INVALID_AMOUNT` and `NETWORK_MISMATCH` are gone
  (the API never sent them); `FORBIDDEN`, `INVALID_DESCRIPTOR_SIGNATURE`, `WALLET_MISMATCH`,
  `WALLET_REMOVED`, `STALE_DESCRIPTOR`, `DESCRIPTOR_REPLAYED`, `BOT_NOT_FOUND` and
  `SORT_UNAVAILABLE` (the EscroBots routes) are added.
- `releasePayment` and `releasePaymentWithOutcome` refuse a PlatformConfig account of the
  wrong length or discriminator before building the transaction, and check its version
  against the shared `CURRENT_ACCOUNT_VERSION`.

## 0.3.0

### Breaking changes

- **State changes are recorded only after the chain confirms them.** The API no longer
  records a create, claim, submit, cancel or dispute when it builds the unsigned
  transaction; it records it at the new `POST /v1/escrows/:address/confirm`, after
  verifying the landed transaction on chain. `createEscrow`, `claimTask`,
  `submitDeliverable`, `cancelEscrow` and `raiseDispute` now call it for you after
  sending (build, sign and send, confirm); their return types are unchanged.
  Clients on 0.2.x never confirm, so against an API with this change their escrows are
  never recorded: upgrade before the API you use deploys it.
- A transaction that landed but could not be confirmed throws the new
  `EscroConfirmError` (`address`, `signature`, `code`). Retry with
  `escro.confirm(address, signature)`; a replay of a recorded transition succeeds.
  Confirm retries a not-yet-visible transaction, an RPC or gateway failure, or a rate
  limit (`RATE_LIMITED`, HTTP 429; confirm has its own per-wallet bucket, apart from the
  build calls) for about 30 s, waiting at least the server's `Retry-After` when it sends
  one, and never retries a rejection (`TX_MISMATCH`, `TX_FAILED`, `ESCROW_INVALID_STATE`).
  Besides the server's codes, `code` is `NETWORK_ERROR` when the last attempt never
  reached the API, or `HTTP_<status>` when the answer carried no code (a gateway 502).
- `raiseDispute` sends `evidence` with the confirm call instead of the build call, and
  rejects an `evidence` that is not a URL before building or signing anything.
  `ApiClient.raiseDispute` takes `{ reason }` only.
- Only the disputant may attach dispute evidence: confirm answers 403 `UNAUTHORIZED`
  to evidence from the counterparty. If the dispute was recorded without evidence
  (either party confirmed it first without any), the disputant's replay with evidence
  attaches it once; a replay
  whose evidence differs from what was recorded is 409 `ESCROW_INVALID_STATE`.

### Added

- `Escro.confirm(address, signature, { evidence? })` and `ApiClient.confirm`.
- `EscroError.retryAfterMs`: the server's `Retry-After` delay, when sent in seconds, on
  any API error that sends it (every rate-limited answer does).

## 0.2.0

### Breaking changes

- **`EscroOptions.cluster` is now required.** Pass `"devnet"` or `"mainnet"` explicitly when constructing the `Escro` client. The previous implicit-devnet behavior is removed so consumers fail-fast at compile time rather than silently picking the wrong cluster.

  Migration:

  ```diff
   const client = new Escro({
  +  cluster: "devnet",       // or "mainnet"
     rpcUrl,
     apiUrl,
     wallet,
   });
  ```

- The exported helpers `fetchPlatformConfig`, `validateTransaction`, `signAndSend`, and `buildReleasePaymentTx` now take a `cluster: SolanaCluster` parameter. If you call these directly (most users don't — they go through the `Escro` client), pass the cluster you intend to talk to.

### Rationale

Each Solana cluster has its own escro program ID. Hardcoding a single ID across both made a devnet keypair compromise sufficient to push to mainnet. Cluster-aware resolution closes that path: each cluster has its own program ID and its own upgrade authority.
