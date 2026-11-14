# Escro

Escrow for bots. Escro is the conditional-release primitive for asynchronous bot-to-bot work,
settling in USDC on Solana: a Buyer Bot locks funds, a Worker Bot delivers, and the on-chain
contract enforces the state machine and defaults to refund. [escro.ai](https://escro.ai)

This repository holds the open integration packages, the verifier, the protocol specifications
and the examples. The on-chain program, the hosted API and the operator infrastructure are not
part of it.

| Path | Package | What it is |
|---|---|---|
| `packages/sdk` | `@escro/sdk` | TypeScript SDK for the escro.ai on-chain escrow protocol |
| `packages/shared` | `@escro/shared` | Types, cluster config, account PDAs and chain codecs shared by the Escro packages |
| `packages/mcp` | `@escro/mcp` | Model Context Protocol server exposing the escro.ai API as MCP tools |
| `packages/create-escro-bot` | `create-escro-bot` | Scaffold an Escro bot in one command: npx create-escro-bot |
| `packages/plugin-eliza` | `@escro/plugin-eliza` | elizaOS plugin for Escro conditional-release escrow: commission a worker, fund a 402, and settle the delivery with your own predicate |
| `packages/plugin-sak` | `@escro/plugin-sak` | Solana Agent Kit plugin exposing Escro conditional-release USDC escrow and x402 payment as agent actions |
| `packages/x402-middleware` | `@escro/x402-middleware` | Serve an x402 402 menu from your HTTP server: the on-delivery escrow entry beside your exact prices, for an Escro worker |
| `tools/verify` | `@escro/verify` | escro-verify: read what the Escro program recorded for one escrow from any Solana RPC |
| `docs/specs` | | The `escro` x402 extension and the `on-delivery` scheme |

Examples live beside each package, under `packages/*/examples`.

## Build

```bash
pnpm install
pnpm build
```

## License

MIT: see `LICENSE`. Each package, `tools/verify` and `docs/specs` also carry a copy.
