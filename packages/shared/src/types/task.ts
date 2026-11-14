/**
 * Broad categories of agent work.
 *
 * Used for analytics and UI display. Use `"custom"` for task types not
 * covered by the built-in categories.
 */
export type TaskType =
  | "code_generation"
  | "code_review"
  | "data_analysis"
  | "content_writing"
  | "translation"
  | "summarization"
  | "question_answering"
  | "image_generation"
  | "audio_transcription"
  | "custom";

/** High-level container format for a deliverable artifact. */
export type DeliverableType = "text" | "json" | "file" | "url" | "code";

/**
 * Constraints on the shape, size, and encoding of the expected deliverable.
 */
export interface DeliverableFormat {
  /** High-level container type. Determines which other fields are applicable. */
  type: DeliverableType;
  /**
   * JSON Schema (draft-07) object the deliverable must validate against.
   * Only applicable when `type === "json"`.
   */
  schema?: Record<string, unknown>;
  /**
   * Expected MIME type of the delivered file (e.g. `"application/pdf"`, `"image/png"`).
   * Only applicable when `type === "file"`.
   */
  mimeType?: string;
  /**
   * Maximum permitted size of the deliverable content in bytes.
   * Applies to `"file"`, `"text"`, `"code"`, and `"json"` types.
   */
  maxSizeBytes?: number;
  /**
   * Programming language identifier for code deliverables (e.g. `"typescript"`, `"python"`).
   * Only applicable when `type === "code"`.
   */
  language?: string;
}

/**
 * A single acceptance criterion that the deliverable must satisfy.
 */
export interface AcceptanceCriterion {
  /**
   * Unique identifier for this criterion within the task spec.
   * Convention: short kebab-case string, e.g. `"ac-correctness"`, `"ac-format"`.
   * Must be unique within a single {@link TaskSpec}.
   */
  id: string;
  /**
   * Human-readable description of what must be true for this criterion to pass.
   */
  description: string;
  /**
   * Relative importance of this criterion.
   * Weights are normalised across all criteria, so only their ratios matter.
   * Defaults to `1.0` when omitted.
   */
  weight?: number;
  /**
   * When `true`, this criterion is mandatory for acceptance.
   * Defaults to `false`.
   */
  required?: boolean;
}

/**
 * Canonical specification of the unit of work held in escrow.
 *
 * This object is:
 *  1. Serialised to canonical UTF-8 JSON (sorted keys, no trailing whitespace).
 *  2. Hashed with SHA-256 → stored on-chain as `EscrowAccount.taskSpecHash`.
 *  3. Written into `create_escrow`'s `spec_hash` bare (`ipfs://<hash>` on older escrows) and
 *     recorded as `EscrowAccount.taskSpecUri` (a label for the hash; Escro stores no spec body,
 *     and the buyer shares the spec itself).
 *
 * Any mutation of the spec changes its hash, invalidating the on-chain record.
 */
export interface TaskSpec {
  /**
   * Semver string identifying the task spec schema version (e.g. `"1.0.0"`).
   * Lets the API, SDKs and bots handle format evolution gracefully.
   * Increment the minor version for backwards-compatible additions;
   * the major version for breaking changes.
   */
  version: string;
  /**
   * Broad category of the task. See {@link TaskType} for supported values.
   */
  taskType: TaskType;
  /**
   * Complete description of the task, written for both the worker performing it
   * and the buyer judging the result (or, in a dispute, the human arbitrator
   * reading it against the delivery). Escro never evaluates a deliverable.
   *
   * Good descriptions:
   *  - State the goal, not just the method.
   *  - Include any non-obvious constraints (language, style, performance bounds).
   *  - Are precise enough that the buyer can check the delivery without ambiguity.
   */
  description: string;
  /**
   * Ordered list of acceptance criteria the deliverable must satisfy.
   * Must contain at least one entry.
   */
  acceptanceCriteria: AcceptanceCriterion[];
  /**
   * Structural and size constraints the deliverable must conform to.
   */
  deliverableFormat: DeliverableFormat;
  /**
   * Arbitrary key-value extension map for protocol plugins, agent hints, or audit trails.
   */
  metadata: Record<string, unknown>;
}
