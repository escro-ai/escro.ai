import { createHash } from "crypto";

import { proofUriError, type TaskSpec } from "@escro/shared";

import type { ServiceAdapter, ServiceResult } from "./adapter.js";
import { EscroError } from "./errors.js";

/** Options controlling {@link assertServiceAdapterContract}. */
export interface AdapterContractOptions {
  /**
   * A representative TaskSpec the adapter can execute. The harness calls
   * `execute(sampleSpec)` and validates the returned ServiceResult, so the spec
   * should be one the adapter genuinely handles.
   */
  sampleSpec: TaskSpec;
}

/** Thrown by {@link assertServiceAdapterContract}, listing every contract violation. */
export class AdapterContractError extends EscroError {
  constructor(
    adapterId: string,
    public readonly violations: string[],
  ) {
    super(
      `ServiceAdapter "${adapterId}" violates the adapter contract:\n- ${violations.join("\n- ")}`,
      "ADAPTER_CONTRACT_VIOLATION",
    );
    this.name = "AdapterContractError";
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Validate the shape and hash integrity of a value returned by `execute`. */
function validateServiceResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) {
    return ["`execute()` must resolve to a ServiceResult object"];
  }
  const violations: string[] = [];
  const r = result as {
    content?: unknown;
    contentHash?: unknown;
    proofUri?: unknown;
    metadata?: unknown;
  };

  const contentIsValid = typeof r.content === "string" || Buffer.isBuffer(r.content);
  if (!contentIsValid) {
    violations.push("`content` must be a string or Buffer");
  }

  if (typeof r.contentHash !== "string" || r.contentHash.trim() === "") {
    violations.push("`contentHash` must be a non-empty string");
  } else if (contentIsValid && r.contentHash !== sha256Hex(r.content as string | Buffer)) {
    violations.push("`contentHash` must equal the SHA-256 hex digest of `content`");
  }

  if (r.proofUri !== undefined && typeof r.proofUri !== "string") {
    violations.push("`proofUri`, when present, must be a string");
  } else if (typeof r.proofUri === "string") {
    const error = proofUriError(r.proofUri);
    if (error !== null) {
      violations.push(`\`proofUri\` cannot be submitted: ${error}`);
    }
  }

  if (typeof r.metadata !== "object" || r.metadata === null || Array.isArray(r.metadata)) {
    violations.push("`metadata` must be a plain object");
  }

  return violations;
}

/**
 * Assert that `adapter` satisfies the ServiceAdapter contract. Resolves with the
 * ServiceResult produced by `execute(sampleSpec)` when the adapter conforms;
 * rejects with an {@link AdapterContractError} listing every violation otherwise.
 *
 * Reusable across adapters (the Bittensor subnets, the compute networks, the proof
 * adapters): a conforming adapter passes, a malformed one fails. The parameter is
 * typed `ServiceAdapter`, but the harness validates at runtime: JS callers and
 * `as`-cast objects reach this too, so every field is checked defensively.
 */
export async function assertServiceAdapterContract(
  adapter: ServiceAdapter,
  options: AdapterContractOptions,
): Promise<ServiceResult> {
  const a = adapter as {
    id?: unknown;
    capabilities?: unknown;
    execute?: unknown;
    healthCheck?: unknown;
  };
  const violations: string[] = [];
  const id = typeof a.id === "string" && a.id.trim() !== "" ? a.id : "(unknown)";

  if (typeof a.id !== "string" || a.id.trim() === "") {
    violations.push("`id` must be a non-empty string");
  }
  // capabilities must be non-empty so the adapter is discoverable in EscroBots.
  if (
    !Array.isArray(a.capabilities) ||
    a.capabilities.length === 0 ||
    (a.capabilities as unknown[]).some((c) => typeof c !== "string" || c.trim() === "")
  ) {
    violations.push("`capabilities` must be a non-empty array of non-empty strings");
  }
  if (typeof a.healthCheck !== "function") {
    violations.push("`healthCheck` must be a function");
  }
  if (typeof a.execute !== "function") {
    violations.push("`execute` must be a function");
  }

  if (typeof a.healthCheck === "function") {
    try {
      const healthy = await (a.healthCheck as () => Promise<unknown>)();
      if (typeof healthy !== "boolean") {
        violations.push("`healthCheck()` must resolve to a boolean");
      }
    } catch (err) {
      violations.push(`\`healthCheck()\` threw: ${errMessage(err)}`);
    }
  }

  let result: ServiceResult | undefined;
  if (typeof a.execute === "function") {
    try {
      result = await (a.execute as (spec: TaskSpec) => Promise<ServiceResult>)(options.sampleSpec);
      violations.push(...validateServiceResult(result));
    } catch (err) {
      violations.push(`\`execute()\` threw: ${errMessage(err)}`);
      result = undefined;
    }
  }

  if (violations.length > 0 || result === undefined) {
    throw new AdapterContractError(
      id,
      violations.length > 0 ? violations : ["`execute()` produced no result"],
    );
  }
  return result;
}
