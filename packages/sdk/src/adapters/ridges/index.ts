/**
 * Ridges (AI coding agents) ServiceAdapter: a SHIPPED, supported reference adapter
 * built on the same pattern as the Gradients SN56 adapter. A Worker Bot
 * wraps a Ridges coding agent behind the `ServiceAdapter` interface: given a coding
 * task, it runs the agent to produce a solution, runs the task's test suite, and
 * returns a test report as the `ServiceResult` deliverable. The Buyer and the escrow
 * contract only ever see USDC.
 *
 * Unlike the Bittensor adapters (gradients SN56, 404gen SN17, lium SN51), Ridges is
 * billed in USD through its platform API, so there is no in-adapter token conversion
 * and no TAO-typed value to keep out of SDK core: `serviceRef` is a bare `"ridges"`,
 * not `bittensor:<subnet>` (kit `ADAPTER_DESCRIPTORS.ridges`). The worker still fronts
 * the service cost and is reimbursed in USDC at release (see README float profile).
 *
 * RELEASE JUDGMENT IS NOT HERE. This adapter only PRODUCES the deliverable (a test
 * report). Whether the suite passed and coverage cleared the target is decided by the
 * BUYER's review.ts, which independently recomputes the outcome from the delivered
 * test outputs (see `scoreRidgesDemoDeliverable`). The worker never scores-for-release
 * and never releases, and its self-reported pass/coverage is never trusted: the
 * buyer is the judge.
 *
 * The coding-agent call and pinning are injectable ports so the reference runs (and is
 * tested) without a live Ridges endpoint or IPFS node. A production worker supplies
 * real implementations (the Ridges platform API for `runAgent`, Pinata/Arweave for
 * `pin`). The port pattern mirrors the gradients adapter deliberately. Ridges is
 * USD-billed with no TAO, so it deliberately does not use the shared `adapters/bittensor`
 * core (that core covers only the Bittensor trio: SN56, SN17, SN51).
 */
import { createHash } from "crypto";

import { canonicalize, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "../../adapter.js";

/** Run the coding agent for `spec`; resolve with the raw deliverable (a test report). */
export type RunCodingAgent = (spec: TaskSpec) => Promise<string | Buffer>;

/** Pin `content` and resolve with a content-addressed proof URI (ipfs://, ar://). */
export type PinContent = (content: string | Buffer) => Promise<string>;

/** Configuration and injectable ports for {@link createRidgesAdapter}. */
export interface RidgesAdapterConfig {
  /** Service identifier. Defaults to "ridges"; forms the adapter id. */
  service?: string;
  /** Advertised capabilities for EscroBots discovery. Defaults to `["code-generation"]`. */
  capabilities?: string[];
  /** Coding-agent port. Default: solves the canned demo kata; a placeholder otherwise. */
  runAgent?: RunCodingAgent;
  /** Pinning port. Default: a deterministic `ipfs://` placeholder URI. */
  pin?: PinContent;
  /** Health-check port. Default: resolves `true`. */
  checkHealth?: () => Promise<boolean>;
}

/**
 * Stable id/capabilities. Locked against `ADAPTER_DESCRIPTORS.ridges` by a kit test
 * (the lock lives in create-escro-bot, which depends on this package).
 */
export const RIDGES_ADAPTER_ID = "ridges";
export const RIDGES_CAPABILITIES = ["code-generation"] as const;

const DEFAULT_SERVICE = "ridges";

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Canned demo kata: a deterministic coding job the buyer
// template's 5-minute journey hires this bot for. The kata is a fixed FizzBuzz
// repo: implement FizzBuzz and make its test battery pass. The deliverable is the
// solution's test report (each battery input and the output the solution produced).
// Acceptance is machine-checkable and recomputed by the BUYER (see
// scoreRidgesDemoDeliverable): every delivered test must pass (exit 0) AND coverage
// of the battery must clear the target. The worker's self-report is never trusted.
// ---------------------------------------------------------------------------

/** Stable marker on the demo spec's metadata so the default agent stub recognizes it. */
export const RIDGES_DEMO_MARKER = "ridges-demo-v1";

/** The demo coverage target: the fraction of the test battery that must be covered. */
export const RIDGES_DEMO_COVERAGE_TARGET = 0.8;

/**
 * The demo's fixed test battery: FizzBuzz over these inputs, chosen to exercise every
 * branch (plain number, Fizz, Buzz, FizzBuzz).
 */
const DEMO_INPUTS: readonly number[] = [1, 2, 3, 5, 15];

/** The kata's reference logic; the buyer recomputes expected outputs from this. */
function fizzbuzz(n: number): string {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}

/**
 * The canned Ridges demo job. Deterministic; its specHash is pinned by a test
 * because the buyer journey depends on hash stability.
 */
export const ridgesDemoJobSpec: TaskSpec = {
  version: "1.0.0",
  taskType: "code_generation",
  description:
    "Implement FizzBuzz for the fixed demo battery and return a test report: for each " +
    "battery input, the output your implementation produced. Acceptance is deterministic " +
    "and recomputed by the buyer: every delivered test must pass (exit 0) and coverage of " +
    "the battery must be >= 0.8; the worker's self-reported pass/coverage is not trusted.",
  acceptanceCriteria: [
    {
      id: "ac-tests-pass",
      description:
        "Every delivered test passes (exit 0), recomputed by the buyer from the test report.",
      required: true,
    },
    {
      id: "ac-coverage",
      description: "Coverage of the demo battery is >= 0.8, recomputed by the buyer.",
      required: true,
    },
  ],
  deliverableFormat: { type: "json" },
  metadata: {
    demo: RIDGES_DEMO_MARKER,
    kata: "fizzbuzz",
    inputs: [...DEMO_INPUTS],
    coverageTarget: RIDGES_DEMO_COVERAGE_TARGET,
  },
};

/** The reference source solution, carried in the deliverable for human readers only. */
const REFERENCE_SOLUTION =
  "export function fizzbuzz(n: number): string {\n" +
  '  if (n % 15 === 0) return "FizzBuzz";\n' +
  '  if (n % 3 === 0) return "Fizz";\n' +
  '  if (n % 5 === 0) return "Buzz";\n' +
  "  return String(n);\n" +
  "}\n";

/**
 * The reference solution to the demo kata: a passing test report over the full
 * battery, plus a (self-reported, buyer-ignored) pass/coverage block, as canonical
 * JSON. Deterministic. Exposed so the demo journey and tests share one source of the
 * expected artifact.
 */
export function solveRidgesDemo(): string {
  const tests = DEMO_INPUTS.map((input) => ({ input, output: fizzbuzz(input) }));
  return canonicalize({
    language: "typescript",
    solution: REFERENCE_SOLUTION,
    coverage: 1,
    passed: true,
    tests,
  });
}

interface DemoTestResult {
  input: number;
  output: string;
}

function parseTestReport(content: string | Buffer): DemoTestResult[] | null {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const tests = (parsed as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) {
    return null;
  }
  const results: DemoTestResult[] = [];
  for (const t of tests) {
    if (typeof t !== "object" || t === null) {
      return null;
    }
    const { input, output } = t as { input?: unknown; output?: unknown };
    if (typeof input !== "number" || typeof output !== "string") {
      return null;
    }
    results.push({ input, output });
  }
  return results;
}

/**
 * The BUYER's independent recompute of the demo acceptance, as a score in [0, 1].
 * It reads the substantive output (the delivered test outputs) and recomputes the
 * expected FizzBuzz result for each; it deliberately IGNORES any self-reported
 * pass/coverage in the deliverable, so release can never be worker-controlled.
 * Semantics:
 *   - Any delivered test whose output is wrong = the suite did not pass (exit != 0):
 *     score 0, no matter how much of the battery is covered.
 *   - Otherwise the score is coverage = (distinct battery inputs delivered) / (battery
 *     size); the buyer releases when it clears {@link RIDGES_DEMO_COVERAGE_TARGET}.
 * Malformed or unparseable content scores 0 and never throws.
 */
export function scoreRidgesDemoDeliverable(content: string | Buffer): number {
  const results = parseTestReport(content);
  if (results === null) {
    return 0;
  }
  const battery = new Set(DEMO_INPUTS);
  const coveredInputs = new Set<number>();
  for (const { input, output } of results) {
    if (!battery.has(input)) {
      // A result outside the battery does not fail the suite and does not count
      // toward coverage; it is simply ignored.
      continue;
    }
    if (output !== fizzbuzz(input)) {
      // A failing test = non-zero exit: the whole suite is rejected.
      return 0;
    }
    coveredInputs.add(input);
  }
  return coveredInputs.size / DEMO_INPUTS.length;
}

// A generic (non-demo) coding job produces a placeholder solution+report so a fresh
// worker returns a well-formed ServiceResult before a real Ridges agent is wired.
function referencePlaceholder(spec: TaskSpec): string {
  return canonicalize({
    language: "typescript",
    solution: "// reference stub - replace the runAgent port with a real Ridges agent call.",
    passed: false,
    tests: [],
    taskType: spec.taskType,
  });
}

const defaultRunAgent: RunCodingAgent = (spec) =>
  Promise.resolve(
    spec.metadata.demo === RIDGES_DEMO_MARKER ? solveRidgesDemo() : referencePlaceholder(spec),
  );

const defaultPin: PinContent = (content) =>
  Promise.resolve(`ipfs://placeholder-${sha256Hex(content).slice(0, 16)}`);

/**
 * Build a Ridges {@link ServiceAdapter}. Passes `assertServiceAdapterContract` with
 * the default ports; supply real ports for production use.
 */
export function createRidgesAdapter(config: RidgesAdapterConfig = {}): ServiceAdapter {
  const service = config.service ?? DEFAULT_SERVICE;
  const capabilities = config.capabilities ?? [...RIDGES_CAPABILITIES];
  const runAgent = config.runAgent ?? defaultRunAgent;
  const pin = config.pin ?? defaultPin;
  const checkHealth = config.checkHealth ?? ((): Promise<boolean> => Promise.resolve(true));

  return {
    id: service,
    capabilities,
    healthCheck: checkHealth,
    async execute(spec: TaskSpec): Promise<ServiceResult> {
      // 1. Run the coding agent and collect the test report (USD-billed; no swap).
      const content = await runAgent(spec);
      // 2. Hash and pin. The result the escrow records is currency-free.
      const contentHash = sha256Hex(content);
      const proofUri = await pin(content);
      return {
        content,
        contentHash,
        proofUri,
        metadata: { adapter: service },
      };
    },
  };
}
