import { z } from "zod";
import { MIN_ESCROW_AMOUNT } from "@escro/shared";
import { PAY_MAX_DEADLINE_SECONDS } from "@escro/sdk";
import type { DeliverableType, TaskType } from "@escro/sdk";

// The kit's OpenAI and LangChain adapters decide what these may be. Each schema is a bare strict ZodObject, because a
// top-level effect fails their instanceof ZodObject and takes the whole tool set down. Under the OpenAI adapter every
// key is required, so an optional string or number is .optional().nullable() in that order and a null means absent.
// An enum stays .optional() only, because the adapter pushes null into a nullable enum's own value list. Descriptions
// sit on the innermost type, which is the one the adapters read.

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

const escrowAddress = (): z.ZodString => z.string().describe("Base-58 address of the escrow");

export const commissionSchema = z
  .object({
    worker: z.string().describe("Base-58 wallet of the worker assigned to the task"),
    amountMicroUsdc: z
      .number()
      .int()
      .min(MIN_ESCROW_AMOUNT)
      .describe("Amount the worker receives in micro-USDC (1 USDC = 1000000), before the fee"),
    deadlineSeconds: z
      .number()
      .int()
      .positive()
      .describe("Seconds from now within which the work must be delivered"),
    task: z
      .object({
        description: z.string().min(1).describe("What the worker must do, stated in full"),
        taskType: z
          .enum(TASK_TYPES)
          .describe("Broad category of the task; custom when omitted")
          .optional(),
        acceptanceCriteria: z
          .array(
            z
              .object({
                id: z.string().min(1).describe("Short identifier, unique within this task"),
                description: z.string().min(1).describe("What must be true of the delivery"),
                required: z
                  .boolean()
                  .describe("Whether the criterion is mandatory for acceptance")
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .describe("The criteria the delivery is judged against, at least one"),
        deliverableType: z
          .enum(DELIVERABLE_TYPES)
          .describe("Format of the deliverable; text when omitted")
          .optional(),
      })
      .strict()
      .describe("The task the worker is commissioned to do"),
  })
  .strict();

export const claimSchema = z.object({ address: escrowAddress() }).strict();

export const submitSchema = z
  .object({
    address: escrowAddress(),
    contentHash: z.string().describe("SHA-256 of the deliverable, as hex"),
    proofUri: z.string().describe("URI of the deliverable or its proof").optional().nullable(),
  })
  .strict();

export const releaseSchema = z.object({ address: escrowAddress() }).strict();

export const readEscrowSchema = z.object({ address: escrowAddress() }).strict();

export const findWorkersSchema = z
  .object({
    capability: z.string().describe("Only workers claiming this capability").optional().nullable(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Most workers to return, 1 to 100")
      .optional()
      .nullable(),
    offset: z.number().int().min(0).describe("Workers to skip").optional().nullable(),
  })
  .strict();

export const reputationSchema = z
  .object({
    wallets: z
      .array(z.string().describe("Base-58 wallet"))
      .min(1)
      .max(20)
      .describe("The wallets to read, 1 to 20"),
  })
  .strict();

/** The furthest deadline, in seconds from now, escro_pay_402 funds unless the call lowers it: 7 days. */
export const PAY_402_MAX_DEADLINE_SECONDS = PAY_MAX_DEADLINE_SECONDS;

// No paymentRequired, policy or admitAcceptance: the pay target stays the caller's own `to` and amount, and a 402
// carrying an acceptance predicate is refused.
export const pay402Schema = z
  .object({
    url: z.string().describe("Absolute http or https URL of the resource that answers 402"),
    to: z
      .string()
      .describe(
        "Base-58 wallet of the worker you mean to pay; the entry must pay exactly this wallet",
      ),
    amountMicroUsdc: z
      .number()
      .int()
      .positive()
      .describe(
        "Amount the worker receives in micro-USDC (1 USDC = 1000000), before the fee; the entry must ask for exactly this amount",
      ),
    method: z
      .enum(["GET", "POST"])
      .describe("HTTP method of the request being paid for; GET when omitted")
      .optional(),
    contentType: z
      .string()
      .describe("Content type of body, sent as content-type")
      .optional()
      .nullable(),
    body: z
      .string()
      .describe("Text body of the request being paid for; refused unless method is POST")
      .optional()
      .nullable(),
    maxDeadlineSeconds: z
      .number()
      .int()
      .min(1)
      .max(PAY_402_MAX_DEADLINE_SECONDS)
      .describe(
        `The latest escrow deadline you accept, in seconds from now, 1 to ${String(PAY_402_MAX_DEADLINE_SECONDS)} (7 days); ${String(PAY_402_MAX_DEADLINE_SECONDS)} when omitted. A 402 whose escrow deadline is later is refused before anything is funded`,
      )
      .optional()
      .nullable(),
  })
  .strict();
