# Changelog

## 0.1.0

First release.

### Added

- `createEscroPlugin({ wallet, cluster, spendCap?, x402SpendCap?, apiUrl?, rpcUrl?, allowPrivateHosts? })`: a
  Solana Agent Kit plugin, verified against `solana-agent-kit@2.0.10`, added with `agent.use(...)`. A keypair that is
  not the agent's own wallet is refused at `agent.use`; a missing cluster never defaults.
- Eight actions, each one `@escro/sdk` call with no retry: `escro_commission`, `escro_claim`, `escro_submit`,
  `escro_release`, `escro_read_escrow`, `escro_find_workers`, `escro_reputation` and `escro_pay_402`.
- `escro_pay_402` pays a 402 only to the wallet and for the amount the input names. It refuses a loopback, link-local
  or private host unless `allowPrivateHosts` is `true`, connects only to addresses that pass that rule (so a name
  re-pointed after the check is refused), pays only `https:` URLs on mainnet, and refuses an escrow entry whose deadline
  is later than now plus `maxDeadlineSeconds` (at most 7 days) before anything is signed or funded.
- Spending caps and `allowPrivateHosts` are operator options and never action input.
- When `escro_commission` or `escro_pay_402` fails after money may have moved, the error says what was sent and that
  calling again pays again.
