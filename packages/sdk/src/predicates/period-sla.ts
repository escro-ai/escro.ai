import {
  PredicateEvaluationError,
  PredicateParamsError,
  consult,
  identifier,
  optionalInteger,
  paramsObject,
  type Predicate,
} from "./core.js";

interface PeriodSlaParams {
  metric: string;
  from: number;
  to: number;
  min: number;
  max: number;
  minSamples: number;
  minCompliance: number;
}

function optionalNumber(params: Record<string, unknown>, field: string): number | undefined {
  if (!Object.hasOwn(params, field)) return undefined;
  const value = params[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PredicateParamsError(`period-sla ${field} must be a finite number`);
  }
  return value;
}

function wholeNumber(params: Record<string, unknown>, field: string): number {
  const value = params[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PredicateParamsError(`period-sla ${field} must be whole unix seconds`);
  }
  return value;
}

// The measurement is the buyer's own monitor's, never anything the worker delivered.
const predicate: Predicate<PeriodSlaParams> = {
  name: "period-sla",
  parseParams(raw) {
    const params = paramsObject("period-sla", raw, [
      "metric",
      "from",
      "to",
      "min",
      "max",
      "minSamples",
      "minCompliance",
    ]);
    const metric = identifier("period-sla", params, "metric");
    const from = wholeNumber(params, "from");
    const to = wholeNumber(params, "to");
    if (from >= to) throw new PredicateParamsError("period-sla from must be before to");
    const min = optionalNumber(params, "min");
    const max = optionalNumber(params, "max");
    if (min === undefined && max === undefined) {
      throw new PredicateParamsError("period-sla needs min, max or both");
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new PredicateParamsError("period-sla min must not exceed max");
    }
    const minSamples = optionalInteger("period-sla", params, "minSamples", 1);
    if (minSamples === undefined) {
      throw new PredicateParamsError("period-sla minSamples is required");
    }
    const minCompliance = optionalNumber(params, "minCompliance") ?? 1;
    if (minCompliance < 0 || minCompliance > 1) {
      throw new PredicateParamsError("period-sla minCompliance must be in [0, 1]");
    }
    return {
      metric,
      from,
      to,
      min: min ?? Number.NEGATIVE_INFINITY,
      max: max ?? Number.POSITIVE_INFINITY,
      minSamples,
      minCompliance,
    };
  },
  async evaluate(_delivery, params, ctx) {
    const answer: unknown = await consult("period-sla", "samples", () =>
      ctx.samples?.({ metric: params.metric, from: params.from, to: params.to }),
    );
    if (!Array.isArray(answer)) {
      throw new PredicateEvaluationError("period-sla: the buyer's samples returned no array");
    }
    const values = answer as unknown[];
    for (const value of values) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new PredicateEvaluationError(
          `period-sla: the buyer's monitor returned the sample ${String(value)}, not a finite number`,
        );
      }
    }
    if (values.length < params.minSamples) {
      return {
        decision: "fail",
        reason: `${String(values.length)} sample(s); at least ${String(params.minSamples)} are needed`,
      };
    }
    const within = (values as number[]).filter((v) => v >= params.min && v <= params.max).length;
    const share = within / values.length;
    return share >= params.minCompliance
      ? {
          decision: "pass",
          reason: `${String(within)} of ${String(values.length)} samples within bounds`,
        }
      : {
          decision: "fail",
          reason: `${String(within)} of ${String(values.length)} samples within bounds; ${String(params.minCompliance)} required`,
        };
  },
};

export const periodSla: Predicate = predicate;
