import { createHash } from "node:crypto";
import { canonicalize, type Acceptance } from "@escro/shared";

import { EscroError } from "../errors.js";

export type PredicateName =
  | "hash-matches"
  | "tests-pass"
  | "json-schema"
  | "file-format"
  | "pod-receipt"
  | "llm-rubric"
  | "ci-check"
  | "period-sla"
  | "attestation-valid";

/** The job a decision record decides (docs/specs/escro-extension.md "Decision record", `job`). */
export interface DecisionJob {
  /** CAIP-2: `solana:<32 base58>` or `eip155:<decimal chain id>`. */
  network: string;
  /** Solana: the base58 program id; ERC-8183: the lowercase `0x` contract address. */
  program: string;
  /** Solana: the escrow PDA, base58; ERC-8183: the jobId in decimal. */
  id: string;
}

/** The one decision record the `escro` extension defines (docs/specs/escro-extension.md "Decision record"). */
export interface DecisionRecord {
  acceptance: Acceptance;
  decision: "pass" | "fail";
  deliverableHash: string;
  job: DecisionJob;
}

export interface Delivery {
  /** The delivered bytes, as the deliverable derivation defines them. */
  bytes: Uint8Array;
  /** pod-receipt: a base58 ed25519 signature. */
  receipt?: string;
  /** attestation-valid: the attestation as the worker supplied it. */
  attestation?: Uint8Array;
}

/** Every external evaluator is the buyer's own function; the library calls nothing else. */
export interface PredicateContext {
  runTests?(i: {
    suite: string;
    delivery: Uint8Array;
  }): Promise<{ passed: number; failed: number }>;
  grade?(i: { rubric: string; model: string; delivery: Uint8Array }): Promise<number>;
  ciStatus?(i: {
    repository: string;
    revision: string;
    check: string;
  }): Promise<"success" | "failure" | "pending" | "missing">;
  samples?(i: { metric: string; from: number; to: number }): Promise<number[]>;
  verifyAttestation?(i: {
    kind: string;
    attestation: Uint8Array;
  }): Promise<{ valid: boolean; subjectSha256: string }>;
}

export interface PredicateOutcome {
  decision: "pass" | "fail";
  reason: string;
}

export interface Predicate<P = unknown> {
  readonly name: PredicateName;
  /** Throws {@link PredicateParamsError}; callable before funding. */
  parseParams(raw: unknown): P;
  evaluate(delivery: Delivery, params: P, ctx: PredicateContext): Promise<PredicateOutcome>;
}

/** Parameters a predicate does not accept, or that do not hash to the advertised `paramsHash`. */
export class PredicateParamsError extends EscroError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "PREDICATE_PARAMS", undefined, options);
    this.name = "PredicateParamsError";
  }
}

/** A decision record, or an `acceptance`, the extension's schema refuses. */
export class PredicateRecordError extends EscroError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "PREDICATE_RECORD", undefined, options);
    this.name = "PredicateRecordError";
  }
}

/** No decision was reached: the buyer's evaluator is absent, failed, or cannot decide yet. */
export class PredicateEvaluationError extends EscroError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "PREDICATE_EVALUATION", undefined, options);
    this.name = "PredicateEvaluationError";
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && SHA256_HEX.test(value);
}

/** RFC 6901: `~` and `/` in a member name are escaped. */
export function pointerTo(parent: string, member: string | number): string {
  return `${parent}/${String(member).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The deepest nesting of arrays and objects {@link jcs} and {@link jsonRefusal} walk before refusing. */
const MAX_JSON_DEPTH = 128;

/**
 * Why `value` is not RFC 8785 JSON, or null when it is: a non-finite number (`canonicalize` would
 * write null), a lone surrogate (escaped), an undefined member (dropped) or item (to null), any value
 * JSON cannot hold, or nesting deeper than {@link MAX_JSON_DEPTH}. The walk stops at that depth, so a
 * counterparty's value cannot overflow the stack here or in the `canonicalize` that follows.
 */
export function jsonRefusal(value: unknown, pointer = "", depth = 0): string | null {
  const at = pointer === "" ? "/" : pointer;
  switch (typeof value) {
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${String(value)} at ${at} is not a JSON number`;
    case "string":
      return LONE_SURROGATE.test(value)
        ? `a lone surrogate at ${at} is not well-formed text`
        : null;
    case "object": {
      if (value === null) return null;
      if (depth >= MAX_JSON_DEPTH) {
        return `${at} nests deeper than ${String(MAX_JSON_DEPTH)} arrays and objects`;
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          const found = jsonRefusal((value as unknown[])[i], pointerTo(pointer, i), depth + 1);
          if (found !== null) return found;
        }
        return null;
      }
      if (!isPlainObject(value)) return `a non-plain object at ${at} is not JSON`;
      for (const [key, member] of Object.entries(value)) {
        if (LONE_SURROGATE.test(key)) return `a member name at ${at} holds a lone surrogate`;
        const found = jsonRefusal(member, pointerTo(pointer, key), depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    default:
      return `a ${typeof value} at ${at} is not JSON`;
  }
}

/** RFC 8785 canonical JSON: a refusal pass ({@link PredicateParamsError}), then the shared `canonicalize`. */
export function jcs(value: unknown): string {
  const refused = jsonRefusal(value);
  if (refused !== null) throw new PredicateParamsError(refused);
  return canonicalize(value);
}

/** The SHA-256 hex of the UTF-8 {@link jcs} of `params`: what `acceptance.paramsHash` carries. */
export function paramsHash(params: unknown): string {
  return sha256Hex(Buffer.from(jcs(params), "utf8"));
}

/** `raw` as a plain object holding no member outside `allowed`. */
export function paramsObject(
  predicate: PredicateName,
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !isPlainObject(raw)) {
    throw new PredicateParamsError(`${predicate} params must be a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new PredicateParamsError(`${predicate} takes no parameter named ${key}`);
    }
  }
  return raw as Record<string, unknown>;
}

const MAX_IDENTIFIER = 256;
const IDENTIFIER = /^[!-~]{1,256}$/;

/** An identifier parameter: 1 to 256 printable ASCII characters, no space. */
export function identifier(
  predicate: PredicateName,
  params: Record<string, unknown>,
  field: string,
): string {
  const value = params[field];
  if (typeof value !== "string" || value.length > MAX_IDENTIFIER || !IDENTIFIER.test(value)) {
    throw new PredicateParamsError(
      `${predicate} ${field} must be 1 to ${String(MAX_IDENTIFIER)} printable ASCII characters with no space`,
    );
  }
  return value;
}

/** An optional whole, non-negative number parameter no smaller than `min`. */
export function optionalInteger(
  predicate: PredicateName,
  params: Record<string, unknown>,
  field: string,
  min: number,
): number | undefined {
  if (!Object.hasOwn(params, field)) return undefined;
  const value = params[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new PredicateParamsError(
      `${predicate} ${field} must be a whole number of at least ${String(min)}`,
    );
  }
  return value;
}

/**
 * The answer of the buyer's evaluator, which `call` invokes through an optional call
 * (`ctx.grade?.(...)`). An absent evaluator, or any failure of it, is a
 * {@link PredicateEvaluationError}: no decision was reached.
 */
export async function consult<T>(
  predicate: PredicateName,
  evaluator: string,
  call: () => Promise<T> | undefined,
): Promise<T> {
  let pending: Promise<T> | undefined;
  try {
    pending = call();
    if (pending !== undefined) return await pending;
  } catch (err) {
    throw new PredicateEvaluationError(
      `${predicate}: the buyer's ${evaluator} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  throw new PredicateEvaluationError(
    `${predicate} needs the buyer's own ${evaluator} function in the predicate context`,
  );
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or null when they are not UTF-8. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}
