import { createHash } from "node:crypto";
import type { TaskSpec } from "../types/index.js";

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// The fields the API's TaskSpec schema keeps; it drops every other key before hashing, so a
// client hashing the raw spec must drop them too. metadata is free-form and kept whole.
const SPEC_KEYS = [
  "version",
  "taskType",
  "description",
  "acceptanceCriteria",
  "deliverableFormat",
  "metadata",
] as const;
const CRITERION_KEYS = ["id", "description", "weight", "required"] as const;
const FORMAT_KEYS = ["type", "schema", "mimeType", "maxSizeBytes", "language"] as const;

function pick(value: unknown, keys: readonly string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]));
}

function normalizeTaskSpec(spec: TaskSpec): unknown {
  const top = pick(spec, SPEC_KEYS) as Record<string, unknown>;
  const criteria = top.acceptanceCriteria;
  return {
    ...top,
    acceptanceCriteria: Array.isArray(criteria)
      ? criteria.map((c) => pick(c, CRITERION_KEYS))
      : criteria,
    deliverableFormat: pick(top.deliverableFormat, FORMAT_KEYS),
  };
}

/** The hex SHA-256 of a TaskSpec's canonical JSON: what an escrow's `spec_hash` holds. */
export function computeTaskSpecHash(spec: TaskSpec): string {
  return createHash("sha256")
    .update(canonicalize(normalizeTaskSpec(spec)), "utf8")
    .digest("hex");
}
