import {
  PredicateEvaluationError,
  consult,
  identifier,
  optionalInteger,
  paramsObject,
  type Predicate,
} from "./core.js";

interface TestsPassParams {
  suite: string;
  minPassed: number;
}

function count(answer: unknown, field: "passed" | "failed"): number {
  const value =
    typeof answer === "object" && answer !== null
      ? (answer as Record<string, unknown>)[field]
      : undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PredicateEvaluationError(
      `tests-pass: the buyer's runTests returned ${field} ${String(value)}, not a non-negative whole number`,
    );
  }
  return value;
}

const predicate: Predicate<TestsPassParams> = {
  name: "tests-pass",
  parseParams(raw) {
    const params = paramsObject("tests-pass", raw, ["suite", "minPassed"]);
    return {
      suite: identifier("tests-pass", params, "suite"),
      minPassed: optionalInteger("tests-pass", params, "minPassed", 1) ?? 1,
    };
  },
  async evaluate(delivery, params, ctx) {
    const answer: unknown = await consult("tests-pass", "runTests", () =>
      ctx.runTests?.({ suite: params.suite, delivery: delivery.bytes }),
    );
    const passed = count(answer, "passed");
    const failed = count(answer, "failed");
    if (failed > 0) {
      return { decision: "fail", reason: `${String(failed)} test(s) of ${params.suite} failed` };
    }
    if (passed < params.minPassed) {
      return {
        decision: "fail",
        reason: `${String(passed)} test(s) of ${params.suite} passed; at least ${String(params.minPassed)} must`,
      };
    }
    return {
      decision: "pass",
      reason: `${String(passed)} test(s) of ${params.suite} passed, none failed`,
    };
  },
};

export const testsPass: Predicate = predicate;
