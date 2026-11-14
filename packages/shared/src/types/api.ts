/**
 * Every machine-readable error code the escro.ai REST API's route handlers send in the `code`
 * field of an error response, and no other. A request Fastify refuses before a handler runs
 * carries Fastify's own `FST_ERR_*` code instead.
 *
 * Consumers should switch on this value to handle errors programmatically
 * rather than parsing the human-readable `error` string.
 */
export type EscrowErrorCode =
  /** The requested escrow PDA does not exist on the specified network. */
  | "ESCROW_NOT_FOUND"
  /** The requested operation is not permitted in the escrow's current state. */
  | "ESCROW_INVALID_STATE"
  /** Release: no settlement of the escrow is recorded or listed yet; retry once the release lands. */
  | "ESCROW_NOT_SETTLED"
  /** Confirm: the escrow PDA was initialised again and the transaction acts on that later lifecycle, which the escrow does not record. */
  | "ESCROW_PDA_REUSED"
  /** Confirm: the transaction cannot be recorded yet (not visible at `confirmed`, an earlier transaction on its escrow unrecorded, or more escrows than a hint records); retry. */
  | "TX_NOT_FOUND"
  /** Confirm: the transaction landed with an error. */
  | "TX_FAILED"
  /** Confirm: the transaction holds no instruction of the program on the escrow, or one the API does not classify. */
  | "TX_MISMATCH"
  /** The Solana RPC read failed; retry. */
  | "RPC_UNAVAILABLE"
  /** Missing, invalid or expired authentication, or a caller not permitted the action. */
  | "UNAUTHORIZED"
  /** EscroBots removal: the signer is not the directory-admin wallet. */
  | "FORBIDDEN"
  /** EscroBots: the bot descriptor's wallet signature does not verify. */
  | "INVALID_DESCRIPTOR_SIGNATURE"
  /** EscroBots: the descriptor names a wallet other than the signer. */
  | "WALLET_MISMATCH"
  /** EscroBots: the wallet was removed from the directory for fraud. */
  | "WALLET_REMOVED"
  /** EscroBots: the descriptor's timestamp is outside the accepted window. */
  | "STALE_DESCRIPTOR"
  /** EscroBots: a newer or equal registration already exists for the wallet. */
  | "DESCRIPTOR_REPLAYED"
  /** EscroBots: no bot is registered for the wallet. */
  | "BOT_NOT_FOUND"
  /** EscroBots: the requested sort needs a reputation source the deployment lacks. */
  | "SORT_UNAVAILABLE"
  /** The caller has exceeded the rate limit; retry after the indicated backoff. */
  | "RATE_LIMITED"
  /** An unexpected server-side error occurred. */
  | "INTERNAL_ERROR"
  /** Request body or query parameters failed schema validation. */
  | "VALIDATION_ERROR";
