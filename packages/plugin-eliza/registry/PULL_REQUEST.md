# Add @escro/plugin-eliza

Adds [`@escro/plugin-eliza`](https://www.npmjs.com/package/@escro/plugin-eliza) to the elizaOS plugin registry.

Escro is the conditional-release primitive for asynchronous bot-to-bot work, settling in USDC on Solana. The plugin lets
a buyer agent lock funds for a worker and settle the delivery in the buyer's own process. Escro never judges quality: the
buyer is the judge, and the contract enforces the state machine.

## Actions

- `COMMISSION_TASK`: locks USDC in an escrow against an assigned worker, optionally without waiting for confirmation.
- `PAY_402`: funds a worker's HTTP 402 on the escrow rail (`on-delivery` or `job-escrow`).
- `REVIEW_DELIVERY`: runs the operator's own predicate over a submitted delivery, then releases, holds or disputes.

## Safety

Text in a chat message spends nothing by default. An operator admits it with `authorizeChatInput` or the
`ESCRO_CHAT_INPUT_CONSENT` setting; the README states what each allows. A character loaded by name has no review hook, so
it can commission once admitted but never release.

The registry entry is `registry/registry-entry.json` in the package directory.
