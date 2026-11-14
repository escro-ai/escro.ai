import {
  PredicateEvaluationError,
  consult,
  identifier,
  paramsObject,
  sha256Hex,
  type Predicate,
} from "./core.js";

interface AttestationValidParams {
  kind: string;
}

// A valid attestation passes only when its subject is these bytes: a proof over other content
// releases nothing.
const predicate: Predicate<AttestationValidParams> = {
  name: "attestation-valid",
  parseParams(raw) {
    const params = paramsObject("attestation-valid", raw, ["kind"]);
    return { kind: identifier("attestation-valid", params, "kind") };
  },
  async evaluate(delivery, params, ctx) {
    const { attestation } = delivery;
    if (attestation === undefined) {
      return { decision: "fail", reason: "the delivery carries no attestation" };
    }
    const verdict: unknown = await consult("attestation-valid", "verifyAttestation", () =>
      ctx.verifyAttestation?.({ kind: params.kind, attestation }),
    );
    if (typeof verdict !== "object" || verdict === null) {
      throw new PredicateEvaluationError(
        "attestation-valid: the buyer's verifyAttestation returned no verdict",
      );
    }
    const { valid, subjectSha256 } = verdict as Record<string, unknown>;
    if (typeof valid !== "boolean") {
      throw new PredicateEvaluationError(
        "attestation-valid: the buyer's verifyAttestation returned no boolean valid",
      );
    }
    if (!valid) return { decision: "fail", reason: `the ${params.kind} attestation is not valid` };
    const subject = sha256Hex(delivery.bytes);
    return subjectSha256 === subject
      ? { decision: "pass", reason: `a valid ${params.kind} attestation covers the delivery` }
      : {
          decision: "fail",
          reason: `the ${params.kind} attestation's subject is not the delivery`,
        };
  },
};

export const attestationValid: Predicate = predicate;
