import { z } from "zod";
import { RAILS, ENABLED_RAILS, RAILS_DOCS_URL, hashMatches, parseUsdc } from "@escro/sdk";

function usdcAmountProblem(usdc: number): string | undefined {
  try {
    parseUsdc(String(usdc));
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function expectedHashProblem(sha256: string): string | undefined {
  try {
    hashMatches.parseParams({ sha256 });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function hireUrlProblem(url: string, requireHttps: boolean): string | undefined {
  if (!URL.canParse(url)) return `Not an absolute URL: ${JSON.stringify(url)}`;
  const { protocol, username, password } = new URL(url);
  if (protocol !== "http:" && protocol !== "https:") return "The URL must be http: or https:";
  if (username !== "" || password !== "") return "The URL must not carry credentials";
  if (requireHttps && protocol !== "https:") return "A mainnet URL must be https:";
  return undefined;
}

// The scaffolder rewrites the name / network / adapter / spendCapUsdc literals
// below. `network` defaults to devnet; mainnet requires the deliberate opt-in
// flag AND a spend cap.
//
// Validation runs at import, so a misconfigured bot fails loudly at START, never
// mid-escrow. Exported so tests can assert the schema's guarantees.

export const ConfigSchema = z
  .object({
    name: z.string().min(1),
    network: z.enum(["devnet", "mainnet"]),
    template: z.literal("buyer"),
    adapter: z.enum([
      "gradients",
      "ridges",
      "404gen",
      "lium",
      "akash",
      "render",
      "gensyn",
      "zkml",
      "custom",
    ]),
    // The rails this bot may use: `escrow` (the default) and `x402`. The check reads
    // @escro/sdk's ENABLED_RAILS, so a rail the SDK does not enable fails config load.
    rails: z
      .array(z.enum(RAILS))
      .default(["escrow"])
      .superRefine((rails, ctx) => {
        for (const rail of rails) {
          if (!ENABLED_RAILS.includes(rail)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["rails"],
              message: `Payment rail "${rail}" is not enabled in this @escro/sdk. Enabled: ${ENABLED_RAILS.join(", ")}. Remove it from "rails". See ${RAILS_DOCS_URL}`,
            });
          }
        }
      }),
    // Spend cap in USDC, on any network; required on mainnet. The SDK enforces it before every
    // escrow this bot creates: amount plus fee, counted against this wallet's open escrows.
    spendCapUsdc: z.number().positive().optional(),
    // The x402 rail's budget in USDC, read only when `x402` is in `rails`. The x402 rail, not
    // listed, is a zero budget; `rails` does not gate the escrow rail. A budget for one process
    // run: it does not refill, and a restart resets it. Separate from spendCapUsdc: neither draws
    // on the other.
    x402SpendCapUsdc: z.number().positive().default(1),
    // Hire `worker` once at startup through its 402, in place of raising the job below. The escrow
    // comes from the offer's `on-delivery` entry and the offer carries the task spec; `input` is
    // the request's JSON body. With this on:
    //   - `job.amountUsdc` is an exact price: a 402 asking anything else is refused.
    //   - `job.deadlineSeconds` bounds the offer's deadline, so it must be at least the worker's
    //     maxTimeoutSeconds + estimatedDurationSeconds + deadlineSafetyBufferSeconds (the kit
    //     worker's defaults total 540 s).
    //   - Each process start hires once, so a restart funds another escrow.
    hire402: z
      .object({
        enabled: z.boolean().default(false),
        url: z.string().default(""),
        method: z.enum(["GET", "POST"]).default("POST"),
        input: z.unknown().optional(),
      })
      .default({}),
    // How the default review in src/review.ts (hash-matches) judges a delivery. It fetches the
    // delivery itself and releases it only when the fetched bytes hash to `expectedSha256` and to
    // the worker's on-chain commitment; the release carries that decision as its memo.
    //   - `expectedSha256`: the SHA-256 (64 lowercase hex) of the exact bytes you expect. Unset, the
    //     bot holds every delivery, and the 24h timeout then pays the worker. Changing it disputes
    //     every still-SUBMITTED escrow committed to the old hash, so release those first. With it
    //     set, a 402 carrying an `acceptance` is funded only when it is this same check; a 402
    //     carrying none is funded as before, and its delivery is still held to the expected hash.
    //   - `allowPrivateHosts`: also fetch from private and loopback addresses (and, on mainnet,
    //     over http:). Off, the fetch connects only to public addresses.
    //   - `maxDeliveryBytes`: a larger delivery is not read.
    // A delivery that cannot be fetched is retried each pass and disputed an hour before the 24h
    // timeout.
    review: z
      .object({
        expectedSha256: z.string().optional(),
        allowPrivateHosts: z.boolean().default(false),
        maxDeliveryBytes: z.number().int().positive().default(10_485_760),
      })
      .default({}),
    // The worker you hire. Pin a specific worker's wallet here, OR leave it ""
    // and set `capability` below to auto-discover one from EscroBots. Leave BOTH
    // empty to run review-only (poll + judge existing jobs, raise no new ones).
    worker: z.string(),
    // Capability to discover a worker for in EscroBots (queries role=worker). Used
    // only when `worker` is "". A registry entry is an unverified CLAIM; your
    // review.ts is the judge. Leave unset to skip discovery.
    capability: z.string().optional(),
    // The job this buyer raises. `amountUsdc` is the worker's NET pay (>= $5
    // minimum, enforced on-chain); `deadlineSeconds` is the horizon from creation.
    job: z.object({
      amountUsdc: z.number().positive(),
      deadlineSeconds: z.number().int().positive(),
      taskType: z.enum([
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
      ]),
      description: z.string().min(1),
      acceptanceCriteria: z
        .array(z.object({ id: z.string().min(1), description: z.string().min(1) }))
        .min(1),
    }),
    // Anonymous time-to-first-escrow funnel events (stage names + durations only; no wallet, no
    // task content). Opt out here or scaffold with --no-telemetry. See
    // src/telemetry.ts.
    telemetry: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.network === "mainnet" && cfg.spendCapUsdc === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spendCapUsdc"],
        message:
          "Mainnet BuyerBot requires spendCapUsdc (in USDC). It is enforced client-side before any escrow is created.",
      });
    }
    if (cfg.rails.includes("x402")) {
      const x402CapProblem = usdcAmountProblem(cfg.x402SpendCapUsdc);
      if (x402CapProblem !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["x402SpendCapUsdc"],
          message: x402CapProblem,
        });
      }
    }
    const refuse = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };
    const amountProblem = usdcAmountProblem(cfg.job.amountUsdc);
    if (amountProblem !== undefined) refuse(["job", "amountUsdc"], amountProblem);
    if (cfg.spendCapUsdc !== undefined) {
      const capProblem = usdcAmountProblem(cfg.spendCapUsdc);
      if (capProblem !== undefined) refuse(["spendCapUsdc"], capProblem);
    }
    if (cfg.review.expectedSha256 !== undefined) {
      const hashProblem = expectedHashProblem(cfg.review.expectedSha256);
      if (hashProblem !== undefined) refuse(["review", "expectedSha256"], hashProblem);
    }
    if (!cfg.hire402.enabled) return;
    const urlProblem = hireUrlProblem(cfg.hire402.url, cfg.network === "mainnet");
    if (urlProblem !== undefined) refuse(["hire402", "url"], urlProblem);
    if (cfg.worker === "") {
      refuse(["worker"], "hire402 needs a pinned worker: the 402 must pay a wallet you named.");
    }
    if (cfg.hire402.method === "GET" && cfg.hire402.input !== undefined) {
      refuse(["hire402", "input"], "A GET carries no body: use POST to send input.");
    }
  });

export type EscroConfig = z.infer<typeof ConfigSchema>;

const config: EscroConfig = ConfigSchema.parse({
  name: "my-bot",
  network: "devnet",
  template: "buyer",
  adapter: "custom",
  rails: ["escrow"],
  spendCapUsdc: undefined,
  hire402: { enabled: false, url: "" },
  worker: "",
  job: {
    amountUsdc: 5,
    deadlineSeconds: 3600,
    taskType: "custom",
    description: "Describe the job you want done here.",
    acceptanceCriteria: [{ id: "ac-1", description: "deliverable meets the spec" }],
  },
  telemetry: true,
});

export default config;
