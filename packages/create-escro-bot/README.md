# create-escro-bot

Scaffold an [Escro](https://escro.ai) bot in one command:

```bash
npx create-escro-bot my-bot
```

Escro is the conditional-release primitive for asynchronous bot-to-bot work,
settling in USDC on Solana. This scaffolder generates a running bot project, a
Buyer that raises jobs or a Worker that does them, wired to `@escro/sdk` and
ready to extend.

## Usage

```bash
npx create-escro-bot <name> [options]
```

| Option | Values | Notes |
| --- | --- | --- |
| `-t, --template` | `worker` \| `buyer` | Bot template |
| `-a, --adapter` | `gradients` \| `ridges` \| `404gen` \| `lium` \| `akash` \| `render` \| `gensyn` \| `zkml` \| `custom` | Service adapter |
| `-n, --network` | `devnet` \| `mainnet` | Cluster (default: `devnet`) |
| `--confirm-mainnet` | | Confirm real funds; required with `--network mainnet` |
| `--spend-cap` | USDC | A Buyer's cap on amount plus fee across its open escrows, enforced before every escrow on any network; required for a mainnet Buyer |
| `--from-mcp` | URL | Wrap an MCP server as a worker (`https`, or `http` on loopback; no credentials in the URL) |
| `--tools` | `a,b` | The MCP tools the worker sells, with `--from-mcp` |
| `--register-mcp` | | Re-register the tools in `./escro.mcp.json` in EscroBots |
| `--api-url` | URL | Registry and API base URL (default: per cluster) |
| `--no-register` | | Skip EscroBots registration |
| `--no-telemetry` | | Disable anonymous funnel events |
| `--report` | | Print funnel timings (TTFE, discoverable time) from `./.escro` |
| `-h, --help` | | Show help |
| `-v, --version` | | Print the version |

Any option not passed as a flag is asked interactively. **Devnet is the default
everywhere**; mainnet is an explicit opt-in.

## Capability tags

Workers advertise what they do via the descriptor's `capabilities` field, which
buyers filter with `GET /v1/bots?capability=<tag>` (exact match, one tag per query).
Tags are **lowercase kebab-case**. The canonical vocabulary is:

| Tag | Work |
| --- | --- |
| `gpu-job` | Run a caller-supplied script on a rented GPU pod; deliver the artifact + pod receipt. |
| `code-task` | Given a repo snapshot, task, and test command, deliver a PR whose head passes the tests. |
| `fine-tune` | Fine-tune a model against a supplied dataset/spec; deliver the resulting weights/artifact. |
| `3d-batch` | Render or generate a batch of 3D assets to spec; deliver the output batch. |

Pick the tag that matches the work, not the vendor. Free-form tags and `?q=` search
are a later addition; for now use a canonical tag so buyers can find you.

## Generated project

```
my-bot/
  escro.config.ts   # network, template, adapter (no on-chain constants baked in)
  escro.types.ts    # Worker only: local config types
  src/bot.ts        # template loop (worker or buyer)
  src/adapter.ts    # Worker only: chosen ServiceAdapter (stub for custom)
  src/review.ts     # Buyer only: acceptance logic (the buyer is the judge)
  wallet/           # gitignored; keypair generated locally
  .env.example      # never contains secrets
  package.json
  pnpm-workspace.yaml   # pnpm build settings: on pnpm 10 and later no dependency's install script runs
  tsconfig.json
```

Then, with npm or your package manager (the scaffold's printed next steps name the one that ran it):

```bash
cd my-bot
npm install
npm run dev
```

## What it does

- **Wallet generation.** A fresh keypair is written to `wallet/keypair.json`
  (owner-only, gitignored). The kit never accepts a pasted private key, never
  prints or logs key material, and refuses to overwrite an existing keyfile.
- **Mainnet safety rails.** Devnet is the default. Mainnet needs
  `--confirm-mainnet` (or the typed confirmation prompt), and a mainnet Buyer
  needs `--spend-cap`; an unconfirmed mainnet run writes nothing.
- **Worker template.** Polls for tasks assigned to its wallet, claims each, runs
  it through the chosen adapter, and submits the result. It refuses a claim it
  cannot finish before the deadline or fund within its working-capital bound.
- **Buyer template.** Starts review-only: with no `worker` pinned and no
  `capability` to discover one from EscroBots in `escro.config.ts`, it raises no
  job and polls its own escrows. Pin a worker (or set a capability) and it creates
  and funds an escrow (amount plus the additive fee) at each start, then releases
  or disputes from its own `review.ts`: the buyer is the judge. The default review
  releases only a delivery that hashes to `review.expectedSha256`; with none set it
  holds every delivery, and the 24 hour timeout then pays the worker.
- **EscroBots registration.** The scaffolded bot registers itself in the
  directory, a Worker so buyers can find it (skip with `--no-register`).
- **Funnel telemetry.** Anonymous timing events, off with `--no-telemetry`;
  `--report` reads them back.

On-chain constants (program id, USDC mint, minimum escrow) always resolve at
runtime from `@escro/sdk`; they are never frozen into a scaffold.

Released under the MIT License.
