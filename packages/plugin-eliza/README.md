# @escro/plugin-eliza

Escrow for AI agents, as an [elizaOS](https://elizaos.ai) plugin. Adds three
buyer-side actions, `COMMISSION_TASK`, `PAY_402` and `REVIEW_DELIVERY`, so an agent can
commission asynchronous bot-to-bot work or fund a worker's 402, and settle the delivery,
with funds held in an Escro conditional-release USDC escrow on Solana. Funds
release when the buyer approves the delivered work, or to the worker 24 hours after
a submission the buyer leaves unreviewed; they default to refund if the work never
arrives.

Escro never judges quality. The agent (the Buyer) reviews and releases; the
on-chain program only enforces the state machine. This plugin is a thin wrapper
over [`@escro/sdk`](https://www.npmjs.com/package/@escro/sdk) and adds no
deliverable evaluation of its own.

## Install

```bash
npm install @escro/plugin-eliza @escro/sdk
```

`@elizaos/core` is provided by your elizaOS runtime at load time. The plugin is typed against
both core lines, 1.x (checked against 1.7.2) and 2.x (checked against 2.0.5): `escroPlugin` and
`createEscroPlugin()` assign to either line's `Plugin` with no cast. It imports no runtime values
from `@elizaos/core` and vendors the small type surface it needs, so it does not install
`@elizaos/core` itself.

## Configure

The plugin reads these settings from the runtime (character `settings`/`secrets`
or environment):

| Setting                             | Required                               | Default                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ESCRO_WALLET_SECRET`               | yes                                    |                                                                             | Base58-encoded ed25519 secret key for the agent's Solana wallet. Provide via secrets/env. Never logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ESCRO_CLUSTER`                     | no                                     | `devnet`                                                                    | `devnet` or `mainnet`. A client injected through `makePay402Action` with this unset takes mainnet's host rule for `PAY_402` and pays only mainnet entries; set `devnet` for devnet's. `PAY_402` pays only entries on this cluster's network.                                                                                                                                                                                                                                                                                                            |
| `ESCRO_RPC_URL`                     | no                                     | public cluster RPC                                                          | Solana RPC endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ESCRO_API_URL`                     | no                                     | the cluster's API (`https://api-devnet.escro.ai` or `https://api.escro.ai`) | Escro REST API base URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ESCRO_CHAT_INPUT_CONSENT`          | no                                     | unset                                                                       | Lets a fenced JSON block in chat spend the wallet. Set only to the exact sentence under [Chat input](#chat-input).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS` | no                                     | unset                                                                       | `1` lets `PAY_402` pay a loopback, link-local or private host, such as a worker on this machine or network. Unset or empty, `PAY_402` refuses such a host before any request; any other value fails the action. The rule follows `ESCRO_CLUSTER`, and a client injected through `makePay402Action` with `ESCRO_CLUSTER` unset takes mainnet's rule: on mainnet `PAY_402` refuses an `http:` URL either way, except to a host this setting admits. The same name and rule as `@escro/mcp`'s environment variable. An operator setting: no input sets it. |
| `ESCRO_SPEND_CAP_USDC`              | on mainnet, to commission or pay a 402 |                                                                             | The most USDC the agent's wallet may hold in open escrows, each counted as amount plus fee (for example `50` or `12.5`). A commission that would pass it is refused before its create is sent; on mainnet every commission is refused while it is unset. An operator setting: a commission carrying a cap is refused. See [Spend cap](#spend-cap).                                                                                                                                                                                                      |

`ESCRO_WALLET_SECRET` is a live signing key. Keep it in your runtime secrets, not
in a committed character file. The example characters in `characters/` deliberately
inline no secret.

### Spend cap

`ESCRO_SPEND_CAP_USDC` is the `@escro/sdk` client's `spendCap`. Before each create the
client reads the wallet's open deposits from the Escro API (FUNDED, IN_PROGRESS,
SUBMITTED, DISPUTED) and adds the creates still in flight in this process, so
concurrent commissions on one agent, or on several agents sharing the wallet in one
process, are checked one at a time against one total.

The cap holds per process. Two processes or hosts using one wallet each enforce it
and together can pass it by the other's in-flight deposits: run one buyer process
per wallet, or give each its share of the cap. A commission that fails after its
create was sent (a network error, a confirmation timeout, an unrecorded confirm)
keeps its deposit in flight until the process restarts, and shrinks the cap's room
until then: the plugin never re-confirms a create.

## Use

Add the plugin to a character:

```json
{
  "name": "MyBuyer",
  "plugins": ["@elizaos/plugin-bootstrap", "@escro/plugin-eliza"],
  "settings": { "ESCRO_CLUSTER": "devnet" }
}
```

The plugin has three buyer-side actions. Each takes structured input from the action
`options`, from `message.content`, or from the first fenced `json` block of the message
text (see [Chat input](#chat-input)).

### `COMMISSION_TASK` (input key `commission`)

```ts
{
  worker: "So1111...11112",        // assigned worker, base58 pubkey
  amountUsdc: 5_000_000,            // micro-USDC (1 USDC = 1_000_000); >= the $5.00 minimum
  deadlineSeconds: 3600,            // or deadlineUnix for an absolute deadline
  wait: false,                      // optional: return once the create is sent, unconfirmed
  task: {
    description: "Summarize the attached document into five bullet points.",
    taskType: "summarization",
    acceptanceCriteria: [{ id: "ac-1", description: "Exactly five bullets", required: true }]
  }
}
```

It maps 1:1 onto the SDK's `createEscrow` and returns the escrow PDA, task id and
signature. With `wait: false` it reports `confirmed: false`: read the escrow until it is
FUNDED before counting on it. A failure that may have landed names the escrow and says
not to retry, because a retry funds a second escrow.

### `PAY_402` (input key `payment`)

`{ url | paymentRequired, to, amountMicroUsdc, deadlineSeconds, method?, contentType?, body? }`
funds a worker's 402 on the escrow rail only (`on-delivery` or `job-escrow`, never `exact` or
`upto`), for exactly that payee and amount and a deadline within `deadlineSeconds`, at most
604800 (7 days). A mainnet `PAY_402` needs only `ESCRO_SPEND_CAP_USDC`.

Before any request or funding, `PAY_402` refuses a URL whose host is a loopback, link-local or
private address, or a name that resolves to one when checked, unless
`ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS` is `1`; on mainnet it pays only `https:` URLs. With
`paymentRequired` the URL checked is the 402's `resource.url`, the one the paid request goes to.
The request connects only to addresses that pass the same rule, from one resolution of the name,
so a name its owner re-points after the check (DNS rebinding) is refused; an escrow entry's job
specification host is held to that rule before anything is funded. The rule needs direct egress and
local DNS: the request resolves each host with this machine's resolver and connects directly to the
admitted addresses, ignoring an HTTP or HTTPS proxy set in the environment, so with a `url` on a
network reachable only through a proxy `PAY_402` fails before anything is funded or signed.

### `REVIEW_DELIVERY` (input key `reviewDelivery`)

`{ escrow }` settles a SUBMITTED escrow with a predicate the operator chose. The hook is
registered in code, never taken from a message:

```ts
import { createEscroPlugin } from "@escro/plugin-eliza";

export default createEscroPlugin({
  review: async (escrow) => ({ check, delivery, onFail: "hold" }), // or null to decide nothing
});
```

A `pass` releases with the predicate's memo. A `fail` holds, or raises a dispute with
`onFail: "dispute"`. The check and the delivered bytes are the operator's own: a message can
name only the escrow.

A character loaded by name uses the default plugin, which has no hook: it can commission once
admitted, and it can never release.

**The 24h hold.** Nothing in the plugin schedules a review. The operator's code, or the
operator's own message, must run `REVIEW_DELIVERY` within 24h of a submit. If nobody does, the
oracle's `timeout_release` pays the worker in full.

### Chat input

Text in a chat message spends nothing by default: `COMMISSION_TASK` and `PAY_402` refuse input
read from a fenced block, before any client is built. An operator opens it one of two ways:

- Register `createEscroPlugin({ authorizeChatInput })`. It receives the `Memory` (a hook can read
  `entityId`) and alone decides; only `true` admits.
- With no such option, set `ESCRO_CHAT_INPUT_CONSENT` in runtime secrets or env to exactly:

  `anyone who can message this agent can spend its wallet`

With either open, whoever they admit can spend the wallet and point `PAY_402` at any public
http(s) URL (any URL at all when `ESCRO_PAY_402_ALLOW_PRIVATE_HOSTS` is `1`). The spend cap bounds open escrows only, so each settled escrow frees room for the next.
`admitAcceptance` for a 402 carrying an acceptance predicate comes only from
`createEscroPlugin` too.

Example characters: [`characters/`](./characters). End-to-end example:
[`examples/localnet-commission.ts`](./examples/localnet-commission.ts) (runs against the
hosted devnet API with a funded devnet wallet).

## License

MIT.
