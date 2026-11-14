import { getCaip2Network, type Acceptance, type SolanaCluster } from "@escro/shared";
import { isCanonicalPubkey } from "@escro/shared/solana";

import { resolveProgramId } from "../solana.js";

import { attestationValid } from "./attestation-valid.js";
import { ciCheck } from "./ci-check.js";
import {
  PredicateParamsError,
  PredicateRecordError,
  isSha256Hex,
  jcs,
  paramsHash,
  sha256Hex,
  type DecisionJob,
  type DecisionRecord,
  type Delivery,
  type Predicate,
  type PredicateContext,
  type PredicateName,
} from "./core.js";
import { fileFormat } from "./file-format.js";
import { hashMatches } from "./hash.js";
import { jsonSchema } from "./json-schema.js";
import { llmRubric } from "./llm-rubric.js";
import { periodSla } from "./period-sla.js";
import { podReceipt } from "./pod-receipt.js";
import { testsPass } from "./tests-pass.js";

export {
  PredicateEvaluationError,
  PredicateParamsError,
  PredicateRecordError,
  jcs,
  paramsHash,
} from "./core.js";
export type {
  DecisionJob,
  DecisionRecord,
  Delivery,
  Predicate,
  PredicateContext,
  PredicateName,
  PredicateOutcome,
} from "./core.js";
export type { Acceptance } from "@escro/shared";
export {
  attestationValid,
  ciCheck,
  fileFormat,
  hashMatches,
  jsonSchema,
  llmRubric,
  periodSla,
  podReceipt,
  testsPass,
};

/** The `escro` extension's predicate catalogue (docs/specs/escro-extension.md "Predicate catalogue"). */
export const PREDICATES: Readonly<Record<PredicateName, Predicate>> = Object.freeze({
  "hash-matches": hashMatches,
  "tests-pass": testsPass,
  "json-schema": jsonSchema,
  "file-format": fileFormat,
  "pod-receipt": podReceipt,
  "llm-rubric": llmRubric,
  "ci-check": ciCheck,
  "period-sla": periodSla,
  "attestation-valid": attestationValid,
});

export interface PredicateCheck {
  acceptance: Acceptance;
  params: unknown;
  /** The job the record decides; build it with {@link predicateJob}. */
  job: DecisionJob;
}

export interface PredicateResult {
  record: DecisionRecord;
  memo: string;
  reason: string;
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_NAME = 64;

function plainMembers(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PredicateRecordError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

// An own member whose value is undefined is refused, never dropped: `canonicalize` would hash it
// as absent.
function checkMembers(
  value: Record<string, unknown>,
  what: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new PredicateRecordError(`${what} has an unexpected member ${key}`);
    }
    if (value[key] === undefined) throw new PredicateRecordError(`${what}.${key} is undefined`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new PredicateRecordError(`${what} lacks ${key}`);
  }
}

/** Refuses an `acceptance` the extension's schema (`$defs.acceptance`) refuses. */
function checkAcceptance(value: unknown): Acceptance {
  const acceptance = plainMembers(value, "acceptance");
  checkMembers(acceptance, "acceptance", ["name", "paramsHash"], ["fixtureHashes"]);
  const { name, fixtureHashes } = acceptance;
  if (typeof name !== "string" || name.length > MAX_NAME || !NAME.test(name)) {
    throw new PredicateRecordError(
      `acceptance.name must be at most ${String(MAX_NAME)} lowercase words joined by hyphens`,
    );
  }
  if (!isSha256Hex(acceptance.paramsHash)) {
    throw new PredicateRecordError("acceptance.paramsHash must be 64 lowercase hex characters");
  }
  if (Object.hasOwn(acceptance, "fixtureHashes")) {
    if (!Array.isArray(fixtureHashes) || !fixtureHashes.every(isSha256Hex)) {
      throw new PredicateRecordError(
        "acceptance.fixtureHashes must be an array of 64-character lowercase hex hashes",
      );
    }
    if (new Set(fixtureHashes).size !== fixtureHashes.length) {
      throw new PredicateRecordError("acceptance.fixtureHashes holds a duplicate");
    }
  }
  return acceptance as unknown as Acceptance;
}

const JOB_MEMBERS = ["network", "program", "id"] as const;
const SOLANA_NETWORK = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;
const EIP155_NETWORK = /^eip155:[1-9][0-9]{0,31}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const EVM_JOB_ID = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Refuses a `job` the extension's schema (`$defs.job`) refuses, and on Solana a `program` or `id`
 * that is not a canonical base58 key of 32 bytes (the decode the schema states in words). Returns a
 * fresh copy holding exactly the three members.
 */
function checkJob(value: unknown, what: string): DecisionJob {
  const job = plainMembers(value, what);
  checkMembers(job, what, JOB_MEMBERS);
  for (const member of JOB_MEMBERS) {
    if (typeof job[member] !== "string") {
      throw new PredicateRecordError(`${what}.${member} must be a string`);
    }
  }
  const { network, program, id } = job as unknown as DecisionJob;
  if (SOLANA_NETWORK.test(network)) {
    if (!isCanonicalPubkey(program)) {
      throw new PredicateRecordError(
        `${what}.program must be a canonical base58 key of 32 bytes on a solana network`,
      );
    }
    if (!isCanonicalPubkey(id)) {
      throw new PredicateRecordError(
        `${what}.id must be the escrow's canonical base58 address of 32 bytes on a solana network`,
      );
    }
  } else if (EIP155_NETWORK.test(network)) {
    if (!EVM_ADDRESS.test(program)) {
      throw new PredicateRecordError(
        `${what}.program must be 0x and 40 lowercase hex characters on an eip155 network`,
      );
    }
    if (!EVM_JOB_ID.test(id)) {
      throw new PredicateRecordError(
        `${what}.id must be the jobId in decimal, with no leading zero, on an eip155 network`,
      );
    }
  } else {
    throw new PredicateRecordError(
      `${what}.network must be solana:<32 base58 characters> or eip155:<decimal chain id>`,
    );
  }
  return { network, program, id };
}

/**
 * The job a record decides on Solana: this cluster's CAIP-2 network and Escro program, and the
 * escrow's address. Throws {@link PredicateRecordError} when `address` is not a canonical base58
 * key of 32 bytes.
 */
export function predicateJob(cluster: SolanaCluster, address: string): DecisionJob {
  if (typeof address !== "string" || !isCanonicalPubkey(address)) {
    throw new PredicateRecordError(
      "job.id must be the escrow's address, a canonical base58 key of 32 bytes",
    );
  }
  return {
    network: getCaip2Network(cluster),
    program: resolveProgramId(cluster).toBase58(),
    id: address,
  };
}

/** Refuses a record the extension's schema (`$defs.decisionRecord`) refuses. */
function checkRecord(value: unknown): DecisionRecord {
  const record = plainMembers(value, "the decision record");
  checkMembers(record, "the decision record", ["acceptance", "decision", "deliverableHash", "job"]);
  checkAcceptance(record.acceptance);
  if (record.decision !== "pass" && record.decision !== "fail") {
    throw new PredicateRecordError("the decision record's decision must be pass or fail");
  }
  if (!isSha256Hex(record.deliverableHash)) {
    throw new PredicateRecordError(
      "the decision record's deliverableHash must be 64 lowercase hex characters",
    );
  }
  checkJob(record.job, "the decision record's job");
  return record as unknown as DecisionRecord;
}

/** The SHA-256 hex of the UTF-8 {@link jcs} of a valid decision record. */
export function decisionRecordHash(record: DecisionRecord): string {
  return sha256Hex(Buffer.from(jcs(checkRecord(record)), "utf8"));
}

/** `escro:predicate:<name>:<pass|fail>:<decisionRecordHash>`. Throws {@link PredicateRecordError}. */
export function predicateMemo(record: DecisionRecord): string {
  const hash = decisionRecordHash(record);
  return `escro:predicate:${record.acceptance.name}:${record.decision}:${hash}`;
}

/**
 * Applies one advertised check to a delivery, in the buyer's process: refuses an `acceptance` the
 * extension refuses, a `job` the extension refuses, a name this library does not implement, params
 * the predicate refuses, and params that do not hash to `acceptance.paramsHash`, all before the
 * predicate runs; then returns the one decision record, naming `check.job`, its memo and the
 * predicate's reason. Throws {@link PredicateEvaluationError} when the buyer's evaluator reaches
 * no decision.
 */
export async function runPredicate(
  check: PredicateCheck,
  delivery: Delivery,
  ctx: PredicateContext = {},
): Promise<PredicateResult> {
  const acceptance = checkAcceptance(check.acceptance);
  const job = checkJob(check.job, "check.job");
  if (!Object.hasOwn(PREDICATES, acceptance.name)) {
    throw new PredicateRecordError(
      `no predicate named ${acceptance.name} is implemented; skip this acceptance`,
    );
  }
  const predicate = PREDICATES[acceptance.name as PredicateName];
  const params = predicate.parseParams(check.params);
  const advertised = paramsHash(check.params);
  if (advertised !== acceptance.paramsHash) {
    throw new PredicateParamsError(
      `the params hash to ${advertised}, not the advertised paramsHash ${acceptance.paramsHash}`,
    );
  }
  const deliverableHash = sha256Hex(delivery.bytes);
  const { decision, reason } = await predicate.evaluate(delivery, params, ctx);
  const record: DecisionRecord = {
    acceptance: {
      name: acceptance.name,
      paramsHash: acceptance.paramsHash,
      ...(acceptance.fixtureHashes === undefined
        ? {}
        : { fixtureHashes: [...acceptance.fixtureHashes] }),
    },
    decision,
    deliverableHash,
    job,
  };
  return { record, memo: predicateMemo(record), reason };
}
