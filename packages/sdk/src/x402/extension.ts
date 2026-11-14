// The `escro` extension's `info` (docs/specs/escro-extension.md), validated by the rules this client
// holds, as escro-extension.schema.json states them. The `schema` a 402 carries is never read: a
// server can ship a laxer one (escro-extension.md, "Where it travels").
import { isRecord, type EscroExtensionInfo } from "@escro/shared";

import { OnDeliveryAcceptError } from "./errors.js";

/** `value` is an object holding every `required` member and no member outside `allowed`. */
export function hasMembers(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => key in value)
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PREDICATE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RECEIPT_SCHEMA = /^[!-~]{1,128}$/;
// https:, then printable ASCII without `#` or `?`, not ending in `/`.
const VERIFIER_URL = /^https:\/\/[!"$->@-~]*[!"$-.0->@-~]$/;
const SERVER_URL = /^https:\/\/[!-~]+$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const INSTRUCTION = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ADDRESS = /^[A-Za-z0-9]{1,128}$/;
const MCP_SERVER = /^[!-~]{1,256}$/;
const MCP_TOOL = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL_LENGTH = 2048;

const ACTIONS = ["fund", "claim", "submit", "poll", "release", "dispute", "cancel", "refund"];
const ACTORS = ["buyer", "worker", "judge", "timekeeper", "arbitrator", "anyone"];

const matches = (value: unknown, pattern: RegExp, maxLength = Infinity): boolean =>
  typeof value === "string" && value.length <= maxLength && pattern.test(value);

const oneOf = (value: unknown, allowed: readonly unknown[]): boolean => allowed.includes(value);

const isInteger = (value: unknown, minimum: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum;

const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
  value === undefined || check(value);

function validAcceptance(value: unknown): boolean {
  if (!hasMembers(value, ["name", "paramsHash", "fixtureHashes"], ["name", "paramsHash"])) {
    return false;
  }
  const hashes = value.fixtureHashes;
  return (
    matches(value.name, PREDICATE_NAME, 64) &&
    matches(value.paramsHash, SHA256_HEX) &&
    optional(
      hashes,
      (v) =>
        Array.isArray(v) && v.every((h) => matches(h, SHA256_HEX)) && new Set(v).size === v.length,
    )
  );
}

function validReceipt(value: unknown): boolean {
  return (
    hasMembers(value, ["schema", "verifierUrl"], ["schema"]) &&
    matches(value.schema, RECEIPT_SCHEMA) &&
    optional(value.verifierUrl, (v) => matches(v, VERIFIER_URL, MAX_URL_LENGTH))
  );
}

function validSettlement(value: unknown): boolean {
  return (
    hasMembers(value, ["reviewWindowSeconds", "settlementMode", "feePayer"]) &&
    isInteger(value.reviewWindowSeconds, 1) &&
    oneOf(value.settlementMode, ["release", "refund"]) &&
    oneOf(value.feePayer, ["client", "worker"])
  );
}

const COMMON = ["action", "actor", "channel", "notBefore"];

function validNextAction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const common =
    oneOf(value.action, ACTIONS) &&
    oneOf(value.actor, ACTORS) &&
    optional(value.notBefore, (v) => isInteger(v, 0));
  if (!common) return false;
  switch (value.channel) {
    case "onchain":
      return (
        hasMembers(
          value,
          [...COMMON, "network", "instruction", "address", "args"],
          ["action", "actor", "channel", "network", "instruction"],
        ) &&
        matches(value.network, CAIP2) &&
        matches(value.instruction, INSTRUCTION) &&
        optional(value.address, (v) => matches(v, ADDRESS)) &&
        optional(value.args, isRecord)
      );
    case "server":
      return (
        hasMembers(
          value,
          [...COMMON, "method", "url"],
          ["action", "actor", "channel", "method", "url"],
        ) &&
        oneOf(value.method, ["GET", "POST"]) &&
        matches(value.url, SERVER_URL, MAX_URL_LENGTH)
      );
    case "mcp":
      return (
        hasMembers(
          value,
          [...COMMON, "server", "tool", "args"],
          ["action", "actor", "channel", "server", "tool"],
        ) &&
        matches(value.server, MCP_SERVER) &&
        matches(value.tool, MCP_TOOL) &&
        optional(value.args, isRecord)
      );
    default:
      return false;
  }
}

/** `info` holds the extension document's rules. */
export function isEscroExtensionInfo(info: unknown): info is EscroExtensionInfo {
  return (
    hasMembers(info, ["acceptance", "receipt", "settlement", "nextActions"], []) &&
    optional(info.acceptance, validAcceptance) &&
    optional(info.receipt, validReceipt) &&
    optional(info.settlement, validSettlement) &&
    optional(info.nextActions, (v) => Array.isArray(v) && v.every(validNextAction))
  );
}

/**
 * The `escro` extension's `info`, validated by the rules this client holds (closed objects; `args`
 * free-form). Throws {@link OnDeliveryAcceptError} with reason `extension_invalid` otherwise.
 */
export function parseEscroExtension(info: unknown): EscroExtensionInfo {
  if (!isEscroExtensionInfo(info)) {
    throw new OnDeliveryAcceptError([{ index: -1, reason: "extension_invalid" }]);
  }
  return info;
}
