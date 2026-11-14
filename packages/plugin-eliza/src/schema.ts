import { z } from "zod";
import { MIN_ESCROW_AMOUNT } from "@escro/shared";
import type {
  AcceptanceCriterion,
  CreateEscrowParams,
  DeliverableFormat,
  DeliverableType,
  TaskSpec,
  TaskType,
} from "@escro/sdk";
import { CommissionInputError } from "./errors.js";

// zod needs the enum values at runtime, but @escro/sdk exports only the TaskType/
// DeliverableType *types*. These tuples are the runtime source; `satisfies` locks
// each to the shared union (no invalid value can drift in), and assigning the
// parsed value into `TaskSpec` below enforces the reverse direction at compile
// time. Same values as the task types the API accepts.
const TASK_TYPES = [
  "code_generation",
  "code_review",
  "data_analysis",
  "content_writing",
  "translation",
  "summarization",
  "question_answering",
  "image_generation",
  "audio_transcription",
  "custom",
] as const satisfies readonly TaskType[];

const DELIVERABLE_TYPES = [
  "text",
  "json",
  "file",
  "url",
  "code",
] as const satisfies readonly DeliverableType[];

/** Default relative deadline (seconds) when the caller supplies no deadline. */
export const DEFAULT_DEADLINE_SECONDS = 3600;

const acceptanceCriterionSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    weight: z.number().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

const deliverableFormatSchema = z
  .object({
    type: z.enum(DELIVERABLE_TYPES),
    schema: z.record(z.unknown()).optional(),
    mimeType: z.string().optional(),
    maxSizeBytes: z.number().int().positive().optional(),
    language: z.string().optional(),
  })
  .strict();

/**
 * Structured input for the `commission_task` action. This is the shape the
 * agent/runtime supplies; it maps 1:1 onto the SDK's `CreateEscrowParams`.
 *
 * `amountUsdc` is micro-USDC (1 USDC = 1_000_000), matching the SDK field
 * exactly - the plugin performs no unit conversion (it is a thin SDK wrapper).
 */
export const commissionInputSchema = z
  .object({
    /** Base-58 public key of the worker being commissioned. */
    worker: z.string().min(32).max(44),
    /** Worker's net payment in micro-USDC. Minimum enforced from shared config. */
    amountUsdc: z.number().int().min(MIN_ESCROW_AMOUNT),
    /** Absolute Unix deadline (seconds). Takes precedence over `deadlineSeconds`. */
    deadlineUnix: z.number().int().positive().optional(),
    /** Relative deadline in seconds from now. Used when `deadlineUnix` is absent. */
    deadlineSeconds: z.number().int().positive().optional(),
    task: z
      .object({
        description: z.string().min(1),
        taskType: z.enum(TASK_TYPES).optional(),
        acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
        deliverableFormat: deliverableFormatSchema.optional(),
        version: z.string().min(1).optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .strict(),
    /** `false` sends the create and returns without waiting for its confirmation. */
    wait: z.boolean().optional(),
  })
  .strict();

export type CommissionInput = z.infer<typeof commissionInputSchema>;

/**
 * Validate and parse raw commission parameters into a {@link CommissionInput}.
 * Throws {@link CommissionInputError} with a readable message on failure.
 */
export function parseCommissionInput(raw: unknown): CommissionInput {
  const result = commissionInputSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new CommissionInputError(`Invalid commission parameters - ${detail}`);
  }
  return result.data;
}

/**
 * Rebuild optional fields so absent values are OMITTED rather than set to
 * `undefined` - the shared domain types are declared under
 * `exactOptionalPropertyTypes`, which distinguishes the two.
 */
function toAcceptanceCriterion(
  c: CommissionInput["task"]["acceptanceCriteria"][number],
): AcceptanceCriterion {
  return {
    id: c.id,
    description: c.description,
    ...(c.weight !== undefined ? { weight: c.weight } : {}),
    ...(c.required !== undefined ? { required: c.required } : {}),
  };
}

function toDeliverableFormat(
  df: NonNullable<CommissionInput["task"]["deliverableFormat"]>,
): DeliverableFormat {
  return {
    type: df.type,
    ...(df.schema !== undefined ? { schema: df.schema } : {}),
    ...(df.mimeType !== undefined ? { mimeType: df.mimeType } : {}),
    ...(df.maxSizeBytes !== undefined ? { maxSizeBytes: df.maxSizeBytes } : {}),
    ...(df.language !== undefined ? { language: df.language } : {}),
  };
}

/**
 * Map a validated {@link CommissionInput} to the SDK's `CreateEscrowParams`,
 * resolving the deadline against `nowUnix`. Throws {@link CommissionInputError}
 * if the resolved deadline is not in the future.
 */
export function buildCreateEscrowParams(
  input: CommissionInput,
  nowUnix: number = Math.floor(Date.now() / 1000),
): CreateEscrowParams {
  const deadlineUnix =
    input.deadlineUnix ?? nowUnix + (input.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS);

  if (deadlineUnix <= nowUnix) {
    throw new CommissionInputError(
      `Deadline ${deadlineUnix.toString()} is not in the future (now ${nowUnix.toString()}).`,
    );
  }

  const taskSpec: TaskSpec = {
    version: input.task.version ?? "1.0.0",
    taskType: input.task.taskType ?? "custom",
    description: input.task.description,
    acceptanceCriteria: input.task.acceptanceCriteria.map(toAcceptanceCriterion),
    deliverableFormat:
      input.task.deliverableFormat !== undefined
        ? toDeliverableFormat(input.task.deliverableFormat)
        : { type: "text" },
    metadata: input.task.metadata ?? {},
  };

  return {
    taskSpec,
    amountUsdc: input.amountUsdc,
    deadlineUnix,
    assignedWorker: input.worker,
  };
}
