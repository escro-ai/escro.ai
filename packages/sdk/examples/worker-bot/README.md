# WorkerBot — Reference Implementation

A complete reference bot showing the worker side of the escrow workflow:

1. Reads the escrow PDA from a file shared off-platform by the buyer.
2. Polls `getMyTasks()` until FUNDED tasks assigned to this wallet appear.
3. Skips tasks with insufficient time remaining before the deadline.
4. Claims each eligible task, executes it through a `ServiceAdapter` (default: the Bittensor adapter), and submits the adapter's deliverable (content hash + proof URI).
5. Handles errors gracefully — never silently leaves a claimed escrow stuck.

The work itself lives behind the `ServiceAdapter` interface exported from `@escro/sdk`, so the bot flow is agnostic to what produced the deliverable and never sees a non-USDC token; the adapter handles any conversion internally.

## Prerequisites

- Node.js 22+
- A Solana wallet keypair with devnet SOL
- The buyer must have already created an escrow with your wallet as `assignedWorker`
- The buyer must have written the escrow PDA to `ESCROW_ID_FILE` (or you set it manually)

## Environment Variables

| Variable         | Required | Description                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------- |
| `WALLET_KEYPAIR` | Yes      | Base58-encoded secret key of the worker wallet                                  |
| `DEVNET_RPC`     | No       | Solana RPC URL (default: `https://api.devnet.solana.com`)                       |
| `API_URL`        | No       | Escro API base URL (default: `http://localhost:3000`)                           |
| `ESCROW_ID_FILE` | No       | File path to read the escrow PDA from (default: `/tmp/escro-e2e-escrow-id.txt`) |

## Running

```bash
# From the repo root
cd packages/sdk

# Install dependencies if needed
npm install

WALLET_KEYPAIR=<base58-secret-key> \
DEVNET_RPC=https://api.devnet.solana.com \
API_URL=http://localhost:3000 \
  npx tsx examples/worker-bot/index.ts
```

## Customising

### The `ServiceAdapter`

`runWorkerBot()` executes each claimed task through a `ServiceAdapter`, injectable via `WorkerBotOptions.adapter` and defaulting to the Bittensor adapter (`createBittensorAdapter()` in `bittensor-adapter.ts`). The adapter owns everything below the escrow: it swaps the worker's USDC budget into the underlying token (e.g. TAO), pays the service (a Bittensor subnet, an Akash deployment, ...), hashes the deliverable, and pins it, returning a currency-free `ServiceResult`. The Buyer and the contract only ever see USDC.

The reference `bittensor-adapter.ts` uses injectable `swap` / `callSubnet` / `pin` ports with stub defaults so the example runs without a live DEX, subnet, or IPFS node. A production worker supplies real implementations (Jupiter for the swap, the subnet dendrite for `callSubnet`, Pinata/Web3.Storage/Arweave for `pin`). Write your own adapter by implementing `ServiceAdapter` and validating it against `assertServiceAdapterContract`.

### `defaultResolveTaskSpec(task)`

Resolves the `TaskSpec` passed to the adapter. Replace (or inject `WorkerBotOptions.resolveTaskSpec`) to get the `TaskSpec` JSON from the buyer and check it hashes to `task.taskSpecHash`; `task.taskSpecUri` is a label for that hash, not a fetchable ID.

### `isDeadlineSafe(task, bufferSeconds)`

Returns `true` when at least `bufferSeconds` remain before `task.deadline`, the escrow's on-chain deadline (the boundary is inclusive). The bot skips a task it could not finish in time instead of claiming it. Injectable via `WorkerBotOptions.isDeadlineSafe`.

## Output Example

```
[WorkerBot] Wallet: 4Nd1mBQtrMJVYVfKf2PX9QhD2xZCDXEaRTRQGsNTt7G
[WorkerBot] Waiting for escrow ID at /tmp/escro-e2e-escrow-id.txt...
[WorkerBot] Got escrow PDA: Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtPTd
[WorkerBot] Polling for assigned FUNDED tasks...
[WorkerBot] Found 1 task(s).
[WorkerBot] Processing task: Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtPTd
[WorkerBot]   Claiming task...
[WorkerBot]   Claimed. Tx: 4zFh...
[WorkerBot]   Executing via adapter bittensor:sn56...
[WorkerBot]   Task spec hash: 9c1e...
[WorkerBot]   Execution complete. Content hash: a3f1...
[WorkerBot]   Proof URI: ipfs://placeholder-a3f1...
[WorkerBot]   Submitting deliverable...
[WorkerBot]   Submitted. Tx: 7gKm...
[WorkerBot] All tasks processed.
```
