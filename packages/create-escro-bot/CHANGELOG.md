# Changelog

## 0.2.0

Relative to 0.1.2: a generated worker can serve a 402 menu (an `on-delivery` escrow price or an
`exact` one settled through a facilitator) and can wrap an MCP server's tools (`--from-mcp`); a
generated buyer can hire a worker through its 402 (`hire402`), can enable the x402 rail under its
own cap (`x402SpendCapUsdc`), and by default reviews with `hash-matches` (the `review` block),
releasing only a delivery it fetched and hashed itself where 0.1.2's default rejected everything;
the buyer's spend cap is the SDK's and counts the fee; a generated bot depends on `@escro/sdk`
^0.5.0 (was ^0.4.2) and needs Node 22; worker deliverable storage is content-addressed, and an
`s3-presigned` config now needs a presign service you run (see Changed for the migration); `--mcp`
is removed; the buyer polls once a minute; and the next steps name the package manager that ran
the scaffold.

### Added

- The buyer can hire its pinned `worker` through the worker's 402 (`src/hire.ts`): set `hire402`
  in `escro.config.ts` (`enabled`, `url`, `method`, `input`; off by default), and the bot hires
  once at startup in place of raising `job`. It pays only an `on-delivery` entry on the bot's own
  network, to exactly `worker`, for exactly `job.amountUsdc`, with a deadline within
  `job.deadlineSeconds`, through `@escro/sdk`'s `deadlineBoundedPolicy`; it never pays an `exact`
  entry, an entry whose deadline is not a whole number of seconds is refused, and every refusal is
  the SDK's text. The config refuses at start a `hire402` with no pinned `worker`, a `url` that is
  not an absolute `http:` or `https:` URL or carries credentials, an `http:` URL on mainnet, and a
  `GET` with `input`. Each process start hires once, so a restart funds another escrow; a hire that
  fails after funding logs the escrow and its signature.
- The buyer's `rails` accepts `x402` (0.1.2 refused it at config load) when `@escro/sdk` enables
  it, under its own budget, `x402SpendCapUsdc` (1 USDC by default): a budget for one process run
  that does not refill, separate from `spendCapUsdc`. With `x402` not listed the budget is zero and
  an x402 payment is refused.
- The buyer's default review is `hash-matches` (it replaces `reject-by-default`), set by the
  `review` block in `escro.config.ts`. It fetches the delivery itself and releases only bytes that
  hash both to `review.expectedSha256` and to the worker's on-chain commitment, with that decision
  as the release's memo; a commitment to another hash, or bytes hashing to something else, is
  disputed. With no `expectedSha256` it holds every delivery, as 0.1.2's default did, and the 24
  hour timeout then pays the worker. The fetch connects only to public addresses over `https:` on
  mainnet (`review.allowPrivateHosts` admits private and loopback hosts, and `http:` on mainnet),
  reads at most `review.maxDeliveryBytes` (10 MiB by default), and refuses before any lookup a
  `proofUri` carrying a username or password or on a port `fetch` blocks (25 or 6667, say), so a
  worker-chosen credential is never sent and those ports are never written to. A delivery it cannot
  fetch is retried each pass and disputed an hour before the 24 hour timeout. With `expectedSha256`
  set, the 402 hire funds an offer carrying an `acceptance` only when it is this same check.
- A `serve402` route with an `exact` price can take `discovery: { description, input, output }`,
  and `serve402` the service's `serviceName`, `tags` and `iconUrl` (`https:`, not SVG): the
  route's 402 then carries a `bazaar` declaration and the service metadata, and its `exact`
  payments hand them to the facilitator, so a discovery catalog can list it. The bot refuses to
  start when `taskSpecFor` throws on `discovery.input`. `escro.config.ts` carries a commented
  example.
- A `serve402` route can take an `exact` price (`exact: { priceUsdc, maxTimeoutSeconds }`) settled
  through `serve402.facilitatorUrl`: the buyer pays the worker's wallet directly and gets the
  adapter's answer in the same request. The answer is due within `maxTimeoutSeconds`, which must
  cover `estimatedDurationSeconds` plus 15 s.
- A generated worker can serve a 402 menu beside its loop: set `serve402` in `escro.config.ts`
  (off by default; with it off the bot opens no port). The generated worker depends on
  `@escro/x402-middleware`, flag on or off. The `serve402` block in `escro.config.ts` describes
  each setting.
- `--from-mcp <url>` scaffolds a worker that sells an MCP server's tools over its 402 menu, with
  `--tools` to confirm them and `--register-mcp` to re-register. Only a flagged worker depends on
  `@modelcontextprotocol/sdk`. See the `--from-mcp` row of the README's options table.

### Changed

- The buyer's `spendCapUsdc` is enforced by `@escro/sdk` before every escrow the bot creates, on
  any network, and counts amount plus fee against the wallet's open escrows; 0.1.2's template
  counted the amount alone, in its own `src/spend-cap.ts`, which is gone.
- `create-escro-bot` and every generated bot declare `engines.node >=22`, the floor of `@escro/sdk` 0.5.0
  (was `>=20.18.0`).
- `--mcp`, which scaffolded nothing, is removed: `--from-mcp` replaces it.
- A generated bot depends on `@escro/sdk` ^0.5.0 (was ^0.4.2).
- The buyer template polls once a minute (was every 15 s). A pass makes two `GET /v1/escrows`
  reads, and the API allows 6 a minute per IP: at 15 s the buyer alone drew 429s, and a kit
  worker on the same address, which makes 4 a minute with its 402 menu on, lost passes beside it.
  A scaffolded bot keeps its own `src/bot.ts`: set its `POLL_INTERVAL_MS` to `60_000`.
- A generated worker reads what it runs on from `src/service.ts`; replace the spec resolver there.
- The worker's deliverable storage gives every deliverable its own content-addressed URL: the
  object key is the unpadded base64url SHA-256 of the uploaded bytes, so a buyer reviewing an
  earlier job still reads that job's bytes. Earlier kits uploaded every deliverable to one URL,
  and each job overwrote the last.
- `s3-presigned` storage takes two settings: `storage.endpoint` is now a presign service you run,
  which answers a POST of `{ key, retentionDays }` with `{ url }`, a presigned PUT URL for that
  key; `storage.publicBase` is the URL prefix buyers read deliverables from, ending in `/`, and
  each `proofUri` is `publicBase + key`. The service must authenticate the bot and mint
  write-once, answering `409` for a key already stored; the worker reads `409` as "already
  stored" and submits `publicBase + key` without uploading again, so a retried job still submits.
  The contract is in the header of the scaffold's `src/storage.ts`.
- An `s3-presigned` config with a fixed `endpoint` (a presigned URL, or any endpoint without a
  `publicBase`) now refuses at start, as does a `publicBase` too long to fit the on-chain proof
  URI cap with a key. To migrate a scaffolded bot: deploy a presign service, set `storage.endpoint` to it and
  `storage.publicBase` to your read prefix, and replace `src/storage.ts` with the template's (a
  scaffolded bot keeps its own copy).

### Fixed

- The printed next steps, and the `--from-mcp` worker's hint to run `mcp:tools`, name the package
  manager that ran the scaffold (`npm` when none is known) instead of always `pnpm`, which a stock
  Node install does not have. The README's quick start uses npm.
- The README says what a fresh buyer does: with no `worker` pinned and no `capability` set it runs
  review-only and raises no job, and with no `review.expectedSha256` it holds every delivery,
  which the 24 hour timeout then pays.
- `ipfs` storage submits `ipfs://<cid>` from the pinning endpoint's `{ cid }` answer instead of
  the pinning endpoint's URL.
- The worker refuses an adapter's own `proofUri` that the API would refuse at submit (an unsafe
  scheme, or over the byte cap) before submitting, logging the escrow, the adapter and why.
- The buyer's cancel pass logs a failing cancel once per distinct reason, and at most three
  times while the escrow stays FUNDED. A reason that came back after another was logged again,
  and one carrying a per-attempt value (a signature, a blockhash) warned on every poll.

## 0.1.2

### Security

- A scaffolded worker on mainnet refuses to claim while it still runs the echo stub adapter
  or the placeholder spec resolver (each would submit made-up work against a buyer's funds);
  it logs which one to replace and idles. Devnet keeps both, so the quick start still runs.
- Registration refuses an `http` API URL other than this machine's loopback: the signed request
  headers would cross the network in clear.

### Fixed

- `--adapter akash`, `render`, `gensyn` and `zkml` scaffold a bot whose config loads: both
  templates' schemas list every adapter the CLI offers (the worker's reads one list in
  `escro.types.ts`). They refused those four at start.

### Changed

- Scaffolded projects depend on `@escro/sdk ^0.4.2`, the release that checks a server-built
  transaction before signing it.

## 0.1.1

### Changed

- The buyer template's `src/review.ts` takes its `Deliverable`, `ReviewResult` and
  `ReviewPolicy` types from `@escro/sdk` (`ZkmlDeliverable`, `ZkmlReviewResult`,
  `ZkmlReviewPolicy`) instead of declaring its own copies. The shapes and the review
  patterns are unchanged.
- The `@vitest/coverage-v8` development dependency is gone from the manifest.

### Fixed

- The buyer template cuts a dispute reason to 200 UTF-8 bytes, between code points (the
  program's cap). It cut 200 characters, so an accented or emoji reason could be refused.
- The buyer template's failed-cancel log forgets an escrow once it is no longer FUNDED and
  logs a cancel again when its error changes. It kept every failed escrow for the bot's life
  and logged only the first error.
