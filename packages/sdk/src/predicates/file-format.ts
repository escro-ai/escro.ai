import {
  PredicateParamsError,
  optionalInteger,
  paramsObject,
  utf8,
  type Predicate,
} from "./core.js";

const SIGNATURES = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "application/zip": [0x50, 0x4b, 0x03, 0x04],
  "model/gltf-binary": [0x67, 0x6c, 0x54, 0x46],
} as const;
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv"] as const;
const MIME_TYPES = ["application/json", ...Object.keys(SIGNATURES), ...TEXT_TYPES];

interface FileFormatParams {
  mimeType: string;
  minSizeBytes: number;
  maxSizeBytes: number;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
}

function matches(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "application/json") {
    const text = utf8(bytes);
    if (text === null) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  if ((TEXT_TYPES as readonly string[]).includes(mimeType)) {
    return !bytes.includes(0) && utf8(bytes) !== null;
  }
  const signature = (SIGNATURES as Record<string, readonly number[] | undefined>)[mimeType];
  return signature !== undefined && startsWith(bytes, signature);
}

const predicate: Predicate<FileFormatParams> = {
  name: "file-format",
  parseParams(raw) {
    const params = paramsObject("file-format", raw, ["mimeType", "minSizeBytes", "maxSizeBytes"]);
    const { mimeType } = params;
    if (typeof mimeType !== "string" || !MIME_TYPES.includes(mimeType)) {
      throw new PredicateParamsError(
        `file-format mimeType must be one of ${MIME_TYPES.join(", ")}`,
      );
    }
    const minSizeBytes = optionalInteger("file-format", params, "minSizeBytes", 0) ?? 0;
    const maxSizeBytes =
      optionalInteger("file-format", params, "maxSizeBytes", 0) ?? Number.MAX_SAFE_INTEGER;
    if (minSizeBytes > maxSizeBytes) {
      throw new PredicateParamsError("file-format minSizeBytes must not exceed maxSizeBytes");
    }
    return { mimeType, minSizeBytes, maxSizeBytes };
  },
  // The size bounds are checked before any content check, so an oversized delivery is never parsed.
  evaluate(delivery, params) {
    const size = delivery.bytes.length;
    if (size < params.minSizeBytes || size > params.maxSizeBytes) {
      return Promise.resolve({
        decision: "fail",
        reason: `the delivery is ${String(size)} bytes, outside [${String(params.minSizeBytes)}, ${String(params.maxSizeBytes)}]`,
      });
    }
    return Promise.resolve(
      matches(params.mimeType, delivery.bytes)
        ? { decision: "pass", reason: `the delivery is ${params.mimeType}` }
        : { decision: "fail", reason: `the delivery's content is not ${params.mimeType}` },
    );
  },
};

export const fileFormat: Predicate = predicate;
