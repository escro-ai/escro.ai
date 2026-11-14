export { Escro } from "./client.js";
export { ApiClient } from "./api.js";
export type {
  EscroOptions,
  CreateEscrowParams,
  CreateEscrowResult,
  SubmitDeliverableParams,
  RaiseDisputeParams,
  ReleasePaymentOutcome,
  ReleaseWithPredicateOutcome,
  SendOptions,
  PollOptions,
  ListOptions,
  PaginatedResult,
  ListBotsParams,
  WorkerCandidate,
  SpendCap,
  X402SpendCap,
} from "./types.js";
export { SPEND_CAP_ERROR_CODES, assertWithinSpendCap, parseUsdc } from "./spend-cap.js";
export { serviceResultToSubmitParams } from "./adapter.js";
export type { ResolveProofUri, ServiceAdapter, ServiceResult } from "./adapter.js";
export { assertServiceAdapterContract, AdapterContractError } from "./adapter-contract.js";
export type { AdapterContractOptions } from "./adapter-contract.js";

// Shipped, supported ServiceAdapters (Gradients SN56 first; the others follow its pattern).
// Importable by generated bots, which can only reach the published @escro/sdk surface.
export {
  createGradientsAdapter,
  gradientsDemoJobSpec,
  solveGradientsDemo,
  scoreGradientsDemoDeliverable,
  tao,
  GRADIENTS_ADAPTER_ID,
  GRADIENTS_CAPABILITIES,
  GRADIENTS_DEMO_EVAL_FLOOR,
  GRADIENTS_DEMO_MARKER,
} from "./adapters/index.js";
export type {
  GradientsAdapterConfig,
  UsdcToTaoSwap,
  SubnetCall,
  PinContent,
  Tao,
} from "./adapters/index.js";
export {
  createRidgesAdapter,
  ridgesDemoJobSpec,
  solveRidgesDemo,
  scoreRidgesDemoDeliverable,
  RIDGES_ADAPTER_ID,
  RIDGES_CAPABILITIES,
  RIDGES_DEMO_MARKER,
  RIDGES_DEMO_COVERAGE_TARGET,
} from "./adapters/index.js";
export type { RidgesAdapterConfig, RunCodingAgent } from "./adapters/index.js";
export {
  create404genAdapter,
  gen404DemoJobSpec,
  solveGen404Demo,
  score404genDemoDeliverable,
  GEN404_ADAPTER_ID,
  GEN404_CAPABILITIES,
  GEN404_DEMO_MARKER,
  GEN404_DEMO_EVAL_FLOOR,
} from "./adapters/index.js";
export type { Gen404AdapterConfig } from "./adapters/index.js";
export {
  createLiumAdapter,
  liumDemoJobSpec,
  solveLiumDemo,
  computeLiumDemoArtifact,
  scoreLiumDemoDeliverable,
  LIUM_ADAPTER_ID,
  LIUM_CAPABILITIES,
  LIUM_DEMO_MARKER,
  LIUM_DEMO_ACCEPT_FLOOR,
} from "./adapters/index.js";
export type { LiumAdapterConfig, RunGpuJob } from "./adapters/index.js";
// Network adapters (re-exported on the package root: generated bots and every
// consumer reach these only through "@escro/sdk", which resolves to this module).
export {
  createAkashAdapter,
  akashDemoJobSpec,
  solveAkashDemo,
  computeAkashDemoArtifact,
  scoreAkashDemoDeliverable,
  akt,
  AKASH_ADAPTER_ID,
  AKASH_CAPABILITIES,
  AKASH_DEMO_MARKER,
  AKASH_DEMO_ACCEPT_FLOOR,
  REFERENCE_MICRO_USDC_PER_AKT,
} from "./adapters/index.js";
export type {
  AkashAdapterConfig,
  Akt,
  UsdcToAktSwap,
  RunAkashDeployment,
} from "./adapters/index.js";
export {
  createRenderAdapter,
  renderDemoJobSpec,
  solveRenderDemo,
  computeRenderDemoArtifact,
  scoreRenderDemoDeliverable,
  renderAmount,
  RENDER_ADAPTER_ID,
  RENDER_CAPABILITIES,
  RENDER_DEMO_MARKER,
  RENDER_DEMO_ACCEPT_FLOOR,
  REFERENCE_MICRO_USDC_PER_RENDER,
} from "./adapters/index.js";
export type {
  RenderAdapterConfig,
  Render,
  UsdcToRenderSwap,
  RunRenderJob,
} from "./adapters/index.js";
export {
  createGensynAdapter,
  gensynDemoJobSpec,
  verifyReeProof,
  gensynAutoRelease,
  gensynProofAutoRelease,
  encodeGensynBundle,
  decodeGensynBundle,
  buildReeProof,
  reproduceGensynCompute,
  GENSYN_ADAPTER_ID,
  GENSYN_CAPABILITIES,
  GENSYN_REE_SCHEME,
  GENSYN_DEMO_MARKER,
} from "./adapters/index.js";
export type {
  GensynAdapterConfig,
  ReeProof,
  ReeVerification,
  ReeVerifyContext,
  ReeExecution,
  GensynDeliverableBundle,
  AutoReleaseDecision,
  ReproduceCompute,
  GensynProofAutoReleaseOptions,
} from "./adapters/index.js";
export {
  createZkmlAdapter,
  zkmlDemoJobSpec,
  solveZkmlDemo,
  buildZkmlProof,
  encodeZkmlProofUri,
  decodeZkmlProofUri,
  verifyZkmlProof,
  verifyZkmlProofUri,
  zkmlProofAutoRelease,
  computeZkmlInputCommitment,
  ZKML_ADAPTER_ID,
  ZKML_CAPABILITIES,
  ZKML_DEMO_MARKER,
  ZKML_DEMO_MODEL_COMMITMENT,
  ZKML_PROOF_SCHEME,
  ZKML_PROOF_URI_PREFIX,
} from "./adapters/index.js";
export type {
  ZkmlProof,
  ZkmlProofBundle,
  ZkmlVerification,
  ZkmlExpectation,
  ZkmlDeliverable,
  ZkmlReviewResult,
  ZkmlReviewPolicy,
  ZkmlProofAutoReleaseOptions,
  ZkmlInferenceOutput,
  ZkmlAdapterConfig,
} from "./adapters/index.js";
export {
  EscroError,
  EscroConfirmError,
  EscrowNotFoundError,
  EscrowStateError,
  EscrowTimeoutError,
  UnauthorizedError,
  EscroRailNotEnabledError,
  EscroPayError,
  ReputationUnavailableError,
} from "./errors.js";
export type { PayRefusal } from "./errors.js";

// The chain reader: what the program recorded for one escrow, read from any Solana RPC with no
// Escro service in the path.
export {
  readEscrowFromChain,
  chainReadConnection,
  decodeEscrowAccount,
  ChainReadError,
  ARCHIVAL_RPC_NOTE,
  ESCROW_ACCOUNT_LAYOUT,
  ESCROW_ACCOUNT_SIZE,
  ESCROW_ACCOUNT_DISCRIMINATOR,
  CHAIN_READ_MAX_TRANSACTIONS,
  CHAIN_READ_MAX_SIGNATURE_PAGES,
} from "./chain-read.js";
export type {
  ChainReadRpc,
  ChainReadTarget,
  ReadEscrowFromChainOptions,
  DecodedEscrowAccount,
  ChainEscrowFigures,
  ChainSettlement,
  ChainEscrowReading,
  ChainReadErrorCode,
  ChainAccountInvalidReason,
} from "./chain-read.js";

// The predicate library: the buyer judges a delivery in its own process with a predicate from the
// `escro` extension's catalogue, and releases with the decision memo.
export {
  PREDICATES,
  hashMatches,
  testsPass,
  jsonSchema,
  fileFormat,
  podReceipt,
  llmRubric,
  ciCheck,
  periodSla,
  attestationValid,
  runPredicate,
  jcs,
  paramsHash,
  decisionRecordHash,
  predicateMemo,
  predicateJob,
  PredicateParamsError,
  PredicateRecordError,
  PredicateEvaluationError,
} from "./predicates/index.js";
export type {
  Acceptance,
  DecisionJob,
  DecisionRecord,
  Delivery,
  Predicate,
  PredicateCheck,
  PredicateContext,
  PredicateName,
  PredicateOutcome,
  PredicateResult,
} from "./predicates/index.js";
export { MEMO_PROGRAM_ID } from "./solana.js";

// EscroRep wire type, re-exported so selection layers (e.g.
// @escro/plugin-eliza) get it transitively through @escro/sdk and take NO direct
// dependency on the private, pure @escro/reputation package. Type-only: erased
// from the JS bundle (no reputation runtime is pulled in), same treatment as the
// @escro/shared types the SDK already re-exports.
export type { ServedWalletReputation } from "./reputation-types.js";

// The dual-path payment surface: both rails are reachable from a 402 through
// `pay()`; the `pay()` signature is frozen.
export { RAILS, ENABLED_RAILS, RAILS_DOCS_URL, EscrowPaymentRouter } from "./payments.js";
export type {
  Rail,
  TxShape,
  PaymentRouter,
  PayParams,
  PaymentResult,
  PayRequest,
  PayOffer,
  PayPolicy,
} from "./payments.js";
// The guards a surface applies before it lets an agent call pay(): a public host, a bounded deadline,
// and the address rule it passes pay().
export {
  isPublicAddress,
  payUrlRefusal,
  payAddressRule,
  deadlineBoundedPolicy,
} from "./pay-guards.js";
export type { PayUrlRefusal, HostLookup } from "./pay-guards.js";
// The port rule pay() and the spec read apply (the Fetch standard's bad ports), as the one table a surface checks.
export { isBadPortUrl } from "./x402/pinned-request.js";
// The ceiling and default of every agent-driven pay surface's deadline bound.
export { PAY_MAX_DEADLINE_SECONDS } from "@escro/shared";

// EscrowState is re-exported as a VALUE (runtime enum), not just a type: a
// kit-generated bot compares `task.state === EscrowState.FUNDED` and cannot reach
// the private @escro/shared, so the enum must be available from @escro/sdk.
export { EscrowState } from "@escro/shared";

// The proof URI cap and its check, as values for the same reason: a kit worker refuses, at config
// load, a storage endpoint whose deliverable URI the API's submit build would reject.
export { MAX_PROOF_URI_BYTES, proofUriError } from "@escro/shared";

// The two shared values the worker's 402 menu (@escro/x402-middleware) reaches through its one edge.
export { computeTaskSpecHash, ONCHAIN_REFUND_GRACE_SECONDS } from "@escro/shared";

// The minimum escrow in micro-USDC, for a kit project that cannot import @escro/shared.
export { MIN_ESCROW_AMOUNT } from "@escro/shared";

// Re-export the shared types most commonly needed by SDK consumers.
export type {
  EscrowAccount,
  Network,
  TaskSpec,
  AcceptanceCriterion,
  DeliverableFormat,
  DeliverableType,
  TaskType,
  EscrowErrorCode,
  ProtocolStats,
  ProtocolStatsFigures,
  BotDescriptor,
  BotRole,
  UnsignedBotDescriptor,
} from "@escro/shared";

// x402 V2 `on-delivery`: the header codecs, the buyer's selection and funding of a 402 entry, and
// the worker's entry builder and payload verifier.
export {
  X402_HEADERS,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentSignature,
  decodePaymentSignature,
  encodePaymentResponse,
  decodePaymentResponse,
  X402CodecError,
  PlatformConfigNotFoundError,
  OnDeliveryAcceptError,
  OnDeliveryFundError,
  EscroFacilitatorError,
  ExactAcceptError,
  buildBazaarDeclaration,
  buildExactAccept,
  exactFeePayer,
  createHttpFacilitator,
  readPlatformConfig,
  SUPPORTED_SETTLEMENT_MODES,
  settlementModeSupported,
  parseEscrowAccept,
  buildEscrowAccept,
  parseEscroExtension,
  BUYER_MESSAGE_METHOD,
  buyerMessage,
  signEscrowPayload,
  fetchTaskSpec,
  fundFromAccept,
  memoryReplayStore,
  ON_DELIVERY_SVM_INVALID_REASONS,
  verifyBuyerPresentation,
  verifyEscrowPayload,
} from "./x402/index.js";
export type {
  OnDeliveryAcceptRefusal,
  OnDeliveryFundRefusal,
  FacilitatorOperation,
  ExactAcceptRefusal,
  BuildBazaarDeclarationOptions,
  BuildExactAcceptOptions,
  HttpFacilitatorOptions,
  PlatformConfigTerms,
  ParseEscrowAcceptContext,
  EscrowAcceptSelection,
  BuildEscrowAcceptOptions,
  FundFromAcceptDeps,
  FundFromAcceptResult,
  ReplayStore,
  OnDeliveryInvalidReason,
  VerifyPresentationContext,
  VerifyEscrowContext,
  BuyerPresentationResult,
  OnDeliveryVerifyResult,
} from "./x402/index.js";
// The x402 wire types, declared once in the shared package.
export type {
  ResourceInfo,
  PaymentRequirements,
  PaymentRequired,
  PaymentPayload,
  SettlementResponse,
  OnDeliveryScheme,
  SettlementMode,
  OnDeliveryExtra,
  OnDeliveryAccept,
  OnDeliveryPayloadFields,
  OnDeliveryPaymentPayload,
  EscroReceipt,
  EscroSettlementTerms,
  EscroNextAction,
  EscroExtensionInfo,
  Facilitator,
  VerifyResponse,
  SupportedKind,
  SupportedResponse,
  BazaarDeclaration,
  BazaarHttpInput,
} from "@escro/shared";
