# BuyerBot — Reference Implementation

A complete reference bot showing the buyer side of the escrow workflow:

1. Creates an escrow with a pre-assigned worker and a sample `data_analysis` task spec.
2. Writes the escrow PDA to a file for off-platform communication with the worker.
3. Polls `getEscrow()` every 10 seconds, logging each state transition.
4. Once the worker submits a deliverable, passes it to your `accept` hook and calls `releasePayment()` only when the hook answers `true`. With no hook, or any other answer, it holds (see below).
5. Exits when the escrow reaches `COMPLETED`, `REFUNDED` or `CANCELLED`, or after it holds. `DISPUTED` is not final: an arbitrator resolves it off-chain and the admin key settles it to `COMPLETED` or `REFUNDED`, so the bot polls on through it.

## The accept hook and the hold default

Escro never judges the deliverable; you do. `runBuyerBot` takes an optional `accept` option:

```ts
await runBuyerBot(client, {
  workerPubkey,
  escrowIdFile,
  accept: async ({ contentHash, proofUri }) => {
    // Fetch and check the deliverable against your task spec; return true to pay.
    return myOwnCheck(contentHash, proofUri);
  },
});
```

The hook is called once per run, with the submitted `contentHash` and `proofUri` (a `ReviewDeliverable` from
`@escro/shared`), and only after the deliverable hash is on the escrow. `true` releases payment; anything else holds. A
hook that throws or rejects makes `runBuyerBot` reject, and nothing is released.

Holding means the bot sends no release and no dispute, logs one line saying so, and returns. The escrow stays
`SUBMITTED`, and the oracle's `timeout_release` pays the worker 24h after submission unless you raise a dispute first.
Holding is not a refusal to pay: to contest a deliverable, raise a dispute yourself (`client.raiseDispute`); the example
never does.

The CLI entrypoint (`main()` in `index.ts`) passes no hook, so running the example as below always holds. Supply
`accept` where you call `runBuyerBot` from your own code, as `examples/full-e2e-test.ts` does.

## Prerequisites

- Node.js 22+
- A Solana wallet keypair with devnet SOL and USDC
- The escro API running (or pointed at a remote instance)

## Environment Variables

| Variable         | Required | Description                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `WALLET_KEYPAIR` | Yes      | Base58-encoded secret key of the buyer wallet                               |
| `WORKER_PUBKEY`  | Yes      | Base58 public key of the pre-assigned worker                                |
| `DEVNET_RPC`     | No       | Solana RPC URL (default: `https://api.devnet.solana.com`)                   |
| `API_URL`        | No       | Escro API base URL (default: `http://localhost:3000`)                       |
| `ESCROW_ID_FILE` | No       | File path to write the escrow PDA (default: `/tmp/escro-e2e-escrow-id.txt`) |

## Running

```bash
# From the repo root
cd packages/sdk

# Install dependencies if needed
npm install

WALLET_KEYPAIR=<base58-secret-key> \
WORKER_PUBKEY=<base58-worker-pubkey> \
DEVNET_RPC=https://api.devnet.solana.com \
API_URL=http://localhost:3000 \
  npx tsx examples/buyer-bot/index.ts
```

## Customising

Edit `SAMPLE_TASK_SPEC` in `index.ts` where the `// TODO` comments are:

- **`taskSpec`** — change `taskType`, `description`, `acceptanceCriteria`, and `deliverableFormat` to describe your actual task.
- **`amountUsdc`** — set the payment in μUSDC (1 USDC = 1 000 000).
- **`deadlineUnix`** — Unix timestamp (seconds) at which the task expires. Must be ≥ now+60s and ≤ now+30 days.

## Output Example

```
[BuyerBot] Wallet: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
[BuyerBot] Creating escrow...
[BuyerBot] Escrow created
[BuyerBot]   PDA:       Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtPTd
[BuyerBot]   ID:        a1b2c3d4e5f6...
[BuyerBot]   Tx:        5KtGpNm...
[BuyerBot] <<< SHARE THIS ESCROW ID OFF-PLATFORM: Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtPTd >>>
[BuyerBot] Escrow PDA written to /tmp/escro-e2e-escrow-id.txt
[BuyerBot] Polling for worker activity (every 10 s)...
[BuyerBot] State transition: (initial) → FUNDED
[BuyerBot] State transition: FUNDED → IN_PROGRESS
[BuyerBot] State transition: IN_PROGRESS → SUBMITTED
[BuyerBot] Holding escrow Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtPTd: no release and no dispute sent. The oracle's timeout_release pays the worker 24h after submission unless the buyer raises a dispute first.
```

With an `accept` hook that answers `true`, the run continues instead:

```
[BuyerBot] State transition: IN_PROGRESS → SUBMITTED
[BuyerBot] Deliverable accepted. Releasing payment...
[BuyerBot] Payment released. Tx: 3aFg...
[BuyerBot] State transition: SUBMITTED → COMPLETED
[BuyerBot] Escrow reached its final state: COMPLETED. Exiting.
```
