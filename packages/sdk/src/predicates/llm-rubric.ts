import {
  PredicateEvaluationError,
  PredicateParamsError,
  consult,
  identifier,
  paramsObject,
  type Predicate,
} from "./core.js";

interface LlmRubricParams {
  rubric: string;
  threshold: number;
  model: string;
}

const MAX_RUBRIC = 8192;
const SURROGATE_PAIR = /[\ud800-\udbff][\udc00-\udfff]/g;

function isUnitScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

// The model is the buyer's, run by the buyer: the library holds no default grader.
const predicate: Predicate<LlmRubricParams> = {
  name: "llm-rubric",
  parseParams(raw) {
    const params = paramsObject("llm-rubric", raw, ["rubric", "threshold", "model"]);
    const { rubric, threshold } = params;
    // A code point is at most two UTF-16 units: the unit count bounds the string before it is walked.
    if (
      typeof rubric !== "string" ||
      rubric.length === 0 ||
      rubric.length > 2 * MAX_RUBRIC ||
      rubric.length - (rubric.match(SURROGATE_PAIR)?.length ?? 0) > MAX_RUBRIC
    ) {
      throw new PredicateParamsError(
        `llm-rubric rubric must be 1 to ${String(MAX_RUBRIC)} code points`,
      );
    }
    if (!isUnitScore(threshold)) {
      throw new PredicateParamsError("llm-rubric threshold must be a number in [0, 1]");
    }
    return { rubric, threshold, model: identifier("llm-rubric", params, "model") };
  },
  async evaluate(delivery, params, ctx) {
    const score: unknown = await consult("llm-rubric", "grade", () =>
      ctx.grade?.({ rubric: params.rubric, model: params.model, delivery: delivery.bytes }),
    );
    if (!isUnitScore(score)) {
      throw new PredicateEvaluationError(
        `llm-rubric: the buyer's grade returned ${String(score)}, not a score in [0, 1]`,
      );
    }
    return score >= params.threshold
      ? {
          decision: "pass",
          reason: `scored ${String(score)}, at least ${String(params.threshold)}`,
        }
      : { decision: "fail", reason: `scored ${String(score)}, below ${String(params.threshold)}` };
  },
};

export const llmRubric: Predicate = predicate;
