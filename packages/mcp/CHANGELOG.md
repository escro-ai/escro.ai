# Changelog

## 0.1.3

### Added

- `pay_402`, a write tool: pays a URL that answers HTTP 402 through `@escro/sdk`'s `pay()`. `to`
  and `amountMicroUsdc` are required and exact, and a 402 that does not offer exactly that is
  refused with nothing funded. It returns the rail, the create signature, the escrow PDA, the
  settlement and a bounded copy of the paid response. When the escrow was funded and the payment
  then failed, the error names the escrow and the recovery. When a request fails after its x402
  payment was signed, the error names that payment's memo, amount and `payTo`.
  `ESCRO_SPEND_CAP_USDC` covers its escrow rail as it covers `create_escrow`; a 402 payable only
  over x402 is refused on the server on mainnet. `@escro/mcp/tools` gains
  `pay402Schema` and the handler.
- `ESCRO_SPEND_CAP_USDC`: the most USDC the server's wallet may hold in open escrows, each
  counted as amount plus fee. `create_escrow` refuses a create that would pass it before
  the create is sent, its error carrying the outstanding, proposed and cap figures, and on
  mainnet refuses every create while it is unset (`@escro/sdk` 0.5.0's `spendCap`). It is an
  operator setting: no tool takes a cap from the agent. `@escro/mcp/env`'s `McpEnv` gains the
  optional `spendCapMicroUsdc`.

### Changed

- `@escro/mcp` declares `engines.node >=22`, the floor of the `@escro/sdk` it bundles.
- `@escro/mcp/tools` types its handler maps: `makeReadHandlers` returns `ReadHandlers` and
  `makeWriteHandlers` returns `WriteHandlers`, one typed entry per tool with its argument
  shape, each resolving to a `ToolResult` (one JSON text block). They were
  `Record<string, (...args: any[]) => Promise<any>>`. Runtime behaviour is unchanged.
- The `@vitest/coverage-v8` development dependency is gone from the manifest.
- Every tool argument carries a description (the escrow list filters, page size and offset
  among them).
- Every base-58 field of every tool, and of the exported schemas in `@escro/mcp/tools`, now
  refuses a value that is not a canonical public key, with an input error naming the field and
  nothing fetched, read from chain or signed.
- `pay_402` refuses, before any request, signature or funding, a URL whose host is a loopback,
  link-local or private address, or a name that resolves to a private address when checked, and
  on mainnet any `http:` URL. `ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS=1` admits such hosts (and, on
  mainnet, `http:` to them only); any value but `1` or empty stops the server at start.
  `@escro/mcp/env`'s `McpEnv` gains the optional `pay402AllowPrivateHosts`, and
  `@escro/mcp/tools`' `makeWriteHandlers` takes optional `options` (`WriteHandlerOptions`:
  `cluster`, `allowPrivateHosts`); without them `pay_402` applies mainnet's `https:` rule and
  refuses private hosts.
- `pay_402` funds an escrow entry only when its `extra.deadline` is at or before now plus
  `maxDeadlineSeconds`, a new optional input: 604800 seconds (7 days) when omitted, lowerable per
  call, never raised. A 402 whose escrow entries are all later than the bound is refused before any chain
  read, spec fetch, API call or signature, and is never paid through an `exact` entry instead. On
  the escrow rail the result also carries the funded entry's `deadline`, `specHash` and `specUri`.
- `pay_402` passes `@escro/sdk`'s address rule to `pay()`, so the request connects only to
  addresses that pass the host rule, from one resolution of the name (a name re-pointed after the
  check is refused), and an escrow entry whose job specification is on a private host is refused
  before anything is funded. Its URL check is the SDK's `payUrlRefusal`.
- `list_escrows` takes `mine`: `true` lists only the escrows this server's wallet created, and
  is refused on a server without a wallet. `@escro/mcp/tools`' `makeReadHandlers` takes optional
  `options` (`ReadHandlerOptions`: `wallet`).
- `pay_402` chooses its entry with `@escro/sdk`'s `deadlineBoundedPolicy`, the policy the Solana
  Agent Kit and Eliza pay actions run. Its refusal of a 402 whose escrow deadline is past the bound
  is now the SDK's text: "The 402 offers no escrow entry paying this worker this amount with a
  deadline at or before <latest> (Unix seconds: now plus <bound>). Nothing was signed or funded."
- `makeWriteHandlers` without a `cluster` (a `@escro/mcp/tools` caller; the server always passes
  one) pays only mainnet entries: a devnet 402 is refused with nothing funded, where it paid the
  first matching entry of any network before.
- `pay_402`'s bound reads `@escro/sdk`'s `PAY_MAX_DEADLINE_SECONDS`.

### Fixed

- `raise_dispute` refuses an empty reason and one over 200 UTF-8 bytes, the program's cap. It
  allowed 200 characters, so an accented or emoji reason passed here and failed on chain.
- `@modelcontextprotocol/sdk` is `^1.32.2` (GHSA-46jr-4wx8-v453). A server started without a
  wallet refuses a tool call whose arguments hold more than 64 array elements and object
  members; a server with a wallet takes no cap (`create_escrow`'s TaskSpec is free-form).
- The published declarations resolve for a consumer: `@escro/mcp/env` types `McpEnv.cluster`
  as `"devnet" | "mainnet"` (it named a type from an unpublished package), and `@escro/sdk` is
  an optional peer dependency, needed only by `@escro/mcp/tools` consumers, whose handlers take
  their own `ApiClient` and `Escro`.

