# The 402 menu on a Cloudflare Worker

`worker.ts` serves one route's 402 menu and answers every other path with its own 404.

Set the bindings with Wrangler:

- `CLUSTER`, `PUBLIC_URL` (an `https:` origin, the Worker's public URL), `API_URL`: plain `[vars]`.
- `RPC_URL`: `wrangler secret put RPC_URL` when the URL carries a provider key.
- `WORKER_SECRET_KEY`: `wrangler secret put WORKER_SECRET_KEY`, the JSON array of the worker wallet's 64 secret key
  bytes. Never in `[vars]` or any committed file: it signs `claim_task` and `submit_deliverable` for the worker wallet.

The menu's replay and job stores are in memory, one per isolate. A Worker with more than one isolate serving traffic
passes shared stores (`replay`, `jobs`) built on Durable Objects or KV.

Dependencies a Worker project installs beside `@escro/x402-middleware`: `@escro/sdk` and `@solana/web3.js`.

Whether the SDK's signing path runs on workerd is unproven until a human run records it.
