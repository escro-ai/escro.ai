// The program's transactions as an off-chain reader decodes them, the SDK's chain reader among
// them: the log walk and the event layouts and decoder. A subpath: a bundle carries it only by
// importing it, as the SDK's chain reader does (and so every bundle that inlines the SDK).

export {
  ESCRO_EVENT_LAYOUTS,
  ESCRO_EVENT_NAMES,
  decodeEscroEvent,
  settleAmountsMatch,
} from "./chain/events.js";
export type {
  EscroEvent,
  EscroEventName,
  EventFieldType,
  EscrowCreatedEvent,
  TaskClaimedEvent,
  DeliverableSubmittedEvent,
  DisputeRaisedEvent,
  EscrowCancelledEvent,
  PaymentReleasedEvent,
  BuyerRefundedEvent,
  SettleAmounts,
} from "./chain/events.js";
export { LogTruncatedError, walkProgramLogs } from "./chain/logs.js";
export type { ProgramLogEvent, ProgramLogWalk } from "./chain/logs.js";
// The transaction versions a reader asks for and the fetch rule its Connection is built with,
// which the chain ingester, the hints and the accuracy harness share; a leaf with no runtime import.
export {
  MAX_SUPPORTED_TRANSACTION_VERSION,
  transactionVersionFetch,
} from "./chain/transaction-version.js";
