/**
 * Shipped, supported ServiceAdapters (main-owned barrel; each adapter lives in its
 * own `adapters/<name>/` directory). These are importable by generated bots, which
 * can only reach the published `@escro/sdk` surface, so anything a reference worker
 * and a scaffolded bot must share lives here, not in `examples/`. Every adapter
 * implements the single `ServiceAdapter` interface and passes
 * `assertServiceAdapterContract` (no parallel adapter interface).
 *
 * The three Bittensor adapters (gradients/SN56, 404gen/SN17, lium/SN51) share the
 * branded `Tao`, the USDC->TAO ports, and the execute skeleton from `./bittensor`; the
 * shared names are surfaced here exactly once from that core. Ridges is USD-billed and
 * does not use the core.
 */

// Shared Bittensor core: the branded Tao + swap/subnet-call/pin ports, surfaced once.
export { tao } from "./bittensor/index.js";
export type { Tao, UsdcToTaoSwap, SubnetCall, PinContent } from "./bittensor/index.js";

export {
  createGradientsAdapter,
  gradientsDemoJobSpec,
  solveGradientsDemo,
  scoreGradientsDemoDeliverable,
  GRADIENTS_ADAPTER_ID,
  GRADIENTS_CAPABILITIES,
  GRADIENTS_DEMO_EVAL_FLOOR,
  GRADIENTS_DEMO_MARKER,
} from "./gradients/index.js";
export type { GradientsAdapterConfig } from "./gradients/index.js";
export {
  createRidgesAdapter,
  ridgesDemoJobSpec,
  solveRidgesDemo,
  scoreRidgesDemoDeliverable,
  RIDGES_ADAPTER_ID,
  RIDGES_CAPABILITIES,
  RIDGES_DEMO_MARKER,
  RIDGES_DEMO_COVERAGE_TARGET,
} from "./ridges/index.js";
export type { RidgesAdapterConfig, RunCodingAgent } from "./ridges/index.js";
export {
  create404genAdapter,
  gen404DemoJobSpec,
  solveGen404Demo,
  score404genDemoDeliverable,
  GEN404_ADAPTER_ID,
  GEN404_CAPABILITIES,
  GEN404_DEMO_MARKER,
  GEN404_DEMO_EVAL_FLOOR,
} from "./404gen/index.js";
export type { Gen404AdapterConfig } from "./404gen/index.js";
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
} from "./lium/index.js";
// Lium's GPU-rental port `RunGpuJob` is an alias of the shared `SubnetCall`; it stays on
// the published surface as a lium-unique name.
export type { LiumAdapterConfig, RunGpuJob } from "./lium/index.js";

// Akash (Cosmos): a standalone adapter with its own branded `Akt` and USDC->AKT swap port;
// it does NOT use the Bittensor core. Its local `PinContent` is not re-exported (the name is
// already surfaced from the Bittensor core above).
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
} from "./akash/index.js";
export type { AkashAdapterConfig, Akt, UsdcToAktSwap, RunAkashDeployment } from "./akash/index.js";

// Render: a same-chain (Solana) network adapter with its own branded `Render` and USDC->RENDER
// swap port; not part of the Bittensor core. Its local `PinContent`/`defaultPin`/`defaultSwap`
// stay internal (the `PinContent` name is already surfaced from the Bittensor core above).
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
} from "./render/index.js";
export type {
  RenderAdapterConfig,
  Render,
  UsdcToRenderSwap,
  RunRenderJob,
} from "./render/index.js";

// Gensyn: the first proof-as-acceptance adapter. `createGensynAdapter` is the worker
// side; `verifyReeProof`/`gensynAutoRelease` are the BUYER-LAYER acceptance surface (the
// protocol still judges nothing — the buyer auto-releases only on a valid REE proof bound
// to its own reproduced deliverable). Not part of the Bittensor core.
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
} from "./gensyn/index.js";
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
} from "./gensyn/index.js";

// ZKML: a proof-as-acceptance sibling of Gensyn. `createZkmlAdapter` is the worker side;
// `verifyZkmlProof`/`verifyZkmlProofUri`/`zkmlProofAutoRelease` are the BUYER-LAYER
// acceptance surface (buyer re-hashes the artifact and verifies the ZK proof before
// releasing; protocol/oracle judge nothing). The reference scheme is a lifecycle demo,
// NOT a sound verifier. Not part of the Bittensor core.
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
} from "./zkml/index.js";
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
} from "./zkml/index.js";
