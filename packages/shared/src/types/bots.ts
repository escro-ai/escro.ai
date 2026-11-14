/**
 * EscroBots v0 - the permissionless capability directory.
 *
 * A bot advertises itself by publishing a wallet-signed capability descriptor.
 * The descriptor is a *claim*, not a verified fact - on-chain history is the
 * verification (surfaced in the v1 directory). The registry performs no
 * approval, review, or ranking; fraud against the protocol is the only removal
 * criterion. The descriptor document itself is independently verifiable: anyone
 * holding it can check `signature` against `wallet` without trusting the API.
 */

/**
 * The advertisable roles. Single source for both the `BotRole` type and the API's
 * validation of a role, so the accepted values and the type cannot drift: a role
 * added here flows into validation automatically.
 */
export const BOT_ROLES = ["worker", "buyer", "both"] as const;

/** Whether the bot hires work, performs work, or both. */
export type BotRole = (typeof BOT_ROLES)[number];

/**
 * The descriptor fields the bot's wallet signs. Everything a registry consumer
 * needs to find and reach the bot, minus the signature over these fields.
 */
export interface UnsignedBotDescriptor {
  /** Base58 Solana pubkey - the advertising bot and the descriptor's signer. */
  wallet: string;
  /** What the bot does in the escrow relationship. */
  role: BotRole;
  /** Free-form capability tags, e.g. `["fine-tune", "eval"]`. Filterable. */
  capabilities: string[];
  /** The underlying service the bot wraps, e.g. `"bittensor:sn56"`. */
  serviceRef: string;
  /** Human-readable pricing guidance, e.g. `"~$5 per fine-tune job"`. */
  pricingHint: string;
  /** Optional http(s) endpoint a buyer can reach the bot at. */
  endpoint?: string;
  /** Unix milliseconds when the descriptor was signed. Monotonic per wallet. */
  signedAt: number;
}

/**
 * A signed capability descriptor as stored and served by the registry.
 * `signature` is a base58 detached Ed25519 signature over the canonical form of
 * the {@link UnsignedBotDescriptor} fields (see `canonicalBotDescriptorMessage`).
 */
export interface BotDescriptor extends UnsignedBotDescriptor {
  /** Base58 detached Ed25519 signature over the canonical unsigned descriptor. */
  signature: string;
}
