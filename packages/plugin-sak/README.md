# @escro/plugin-sak

Escrow for AI agents, as a [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) plugin. Eight actions let
an agent commission a worker, claim, submit, release, read an escrow, browse the directory and reputation, and pay an
HTTP 402, settling in USDC on Solana. Escrowed funds release when the buyer approves the delivered work, or 24 hours
after delivery if the buyer neither releases nor disputes, and default to refund if the work never arrives. Escro never
judges quality.

## Install

```bash
npm install @escro/plugin-sak @escro/sdk solana-agent-kit@2.0.10 zod@^3.25.40 @solana/web3.js
```

`solana-agent-kit` is your agent's own dependency, and this package does not declare it: the plugin imports no runtime value from it. It is verified against `solana-agent-kit@2.0.10`; a later version may work, but check that its plugin contract still matches before relying on it.

## Use

```ts
import { KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import { createEscroPlugin } from "@escro/plugin-sak";

const agent = new SolanaAgentKit(new KeypairWallet(keypair, rpcUrl), rpcUrl, {}).use(
  createEscroPlugin({
    wallet: keypair,
    cluster: "mainnet",
    spendCap: { maxOutstandingMicroUsdc: 50_000_000 },
    x402SpendCap: { maxMicroUsdc: 10_000_000 },
  }),
);
```

| Option              | Required                                               | Notes                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet`            | yes                                                    | The agent wallet's own `Keypair`. A keypair that is not the agent's wallet is refused at `agent.use`.                                                                                            |
| `cluster`           | yes                                                    | `"devnet"` or `"mainnet"`; there is no default.                                                                                                                                                  |
| `spendCap`          | on mainnet, to commission or to pay an on-delivery 402 | The most this wallet may hold in open escrows.                                                                                                                                                   |
| `x402SpendCap`      | on mainnet, to pay an `exact` 402                      | The x402 rail's own budget; `spendCap` does not stand in for it.                                                                                                                                 |
| `apiUrl`, `rpcUrl`  | no                                                     | Default to the cluster's public endpoints.                                                                                                                                                       |
| `allowPrivateHosts` | no                                                     | `true` lets `escro_pay_402` pay a loopback, link-local or private host, such as a worker on this machine. Absent or `false` refuses such hosts; any other value makes `createEscroPlugin` throw. |

Caps and `allowPrivateHosts` are your options and never action input: an LLM cannot set or raise one.

## Actions

`escro_commission`, `escro_claim`, `escro_submit`, `escro_release`, `escro_read_escrow`, `escro_find_workers`,
`escro_reputation`, `escro_pay_402`. Each makes one `@escro/sdk` call and never retries.

### `escro_pay_402`

`{ url, to, amountMicroUsdc, method?, contentType?, body?, maxDeadlineSeconds? }` pays a 402 only to `to` and for
exactly `amountMicroUsdc`. Before any request it refuses a URL whose host is a loopback, link-local or private
address, or a name that resolves to one when checked, unless `allowPrivateHosts` is `true`; on mainnet it pays only
`https:` URLs, following the plugin's `cluster`. The request connects only to addresses that pass the same rule, from
one resolution of the name, so a name its owner re-points after the check (DNS rebinding) is refused; an escrow entry's
job specification host is held to that rule before anything is funded. The rule needs direct egress and local DNS: the
request resolves each host with this machine's resolver and connects directly to the admitted addresses, ignoring an
HTTP or HTTPS proxy set in the environment, so on a network reachable only through a proxy `escro_pay_402` fails before
anything is funded or signed.

An escrow entry whose deadline is later than now plus `maxDeadlineSeconds` (1 to 604800; 604800, 7 days, when
omitted) is refused before any chain read, signature or funding, and is never passed over for an `exact` entry.

## Custody

The key is yours: the plugin hands the keypair only to `@escro/sdk`, which alone signs, and reads no key from the
environment or a file. A wallet with no local key (an embedded wallet, an MPC signer) is not supported.

`escro_commission` and `escro_pay_402` move money. When one fails after money may have moved, its error says what
was sent and that calling again pays again.

## License

MIT
