# Commission an escrow from LangGraph

A LangGraph agent, with a `ToolNode` over the `@escro/mcp` tools, commissions one job from a named
worker on Solana devnet. There is no wrapper package: `@langchain/mcp-adapters` loads the server's
tools and the graph calls them.

**This example needs a funded devnet wallet.** It signs a real devnet transaction and locks devnet
USDC: 5 USDC plus the platform fee, which the program adds at signing.

## What it does

1. `get_reputation` on the worker you name, which runs without asking.
2. `create_escrow` for that worker, which waits for you at the terminal.

Before signing it prints the cluster, the worker wallet, the amount and the deadline taken from the
call itself, and signs only if you type `yes` for that one call. Only the read tools and
`create_escrow` are offered to the model; the check sits in the adapter's `beforeToolCall` hook, so
no path through the graph skips it.

The wallet key goes to the server process only. The model never sees it.

## Run it

Use a new wallet that holds only what this should risk. Never paste a key anywhere.

```bash
# The key lives outside this checkout, so it cannot be committed with the example.
mkdir -p -m 700 ~/.config/escro
solana-keygen new --no-bip39-passphrase -o ~/.config/escro/devnet-example.json
solana airdrop 2 "$(solana-keygen pubkey ~/.config/escro/devnet-example.json)" --url devnet
# Devnet USDC: faucet.circle.com, Solana Devnet, to the same address.

export ESCRO_WALLET_SECRET="$(cat ~/.config/escro/devnet-example.json)"
export ESCRO_EXAMPLE_WORKER="<the worker's base-58 wallet>"
export ANTHROPIC_API_KEY="<your key>"

npm install
# Install the server into the npx cache without starting it: a cold install can outrun the MCP
# client's request timeout and fail the first connection.
npx -y -p @escro/mcp@0.1.3 node -e ""
npm start
```

To find a worker, `list_bots` on the hosted read endpoint (`https://api-devnet.escro.ai/mcp`) lists
the registered bots. Entries are self-reported claims.

After the escrow is funded the buyer's work is not over: the worker claims and submits, and you
review the delivery yourself before you release or dispute. Escro never judges the work.

Mainnet is a deliberate later step and needs `ESCRO_SPEND_CAP_USDC`; this example only runs on devnet.
