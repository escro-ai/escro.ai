import {
  PredicateEvaluationError,
  consult,
  identifier,
  paramsObject,
  utf8,
  type Predicate,
} from "./core.js";

interface CiCheckParams {
  repository: string;
  check: string;
}

const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const predicate: Predicate<CiCheckParams> = {
  name: "ci-check",
  parseParams(raw) {
    const params = paramsObject("ci-check", raw, ["repository", "check"]);
    return {
      repository: identifier("ci-check", params, "repository"),
      check: identifier("ci-check", params, "check"),
    };
  },
  async evaluate(delivery, params, ctx) {
    // A delivery that is not a revision never reaches the buyer's CI client.
    const revision = utf8(delivery.bytes)?.trim();
    if (revision === undefined || !REVISION.test(revision)) {
      return {
        decision: "fail",
        reason: "the delivery is not a 40- or 64-character lowercase hex revision",
      };
    }
    const status: unknown = await consult("ci-check", "ciStatus", () =>
      ctx.ciStatus?.({ repository: params.repository, revision, check: params.check }),
    );
    switch (status) {
      case "success":
        return { decision: "pass", reason: `${params.check} succeeded at ${revision}` };
      case "failure":
      case "missing":
        return { decision: "fail", reason: `${params.check} is ${status} at ${revision}` };
      case "pending":
        throw new PredicateEvaluationError(
          `ci-check: ${params.check} is still pending at ${revision}; no decision yet`,
        );
      default:
        throw new PredicateEvaluationError(
          `ci-check: the buyer's ciStatus returned ${String(status)}, not a CI status`,
        );
    }
  },
};

export const ciCheck: Predicate = predicate;
