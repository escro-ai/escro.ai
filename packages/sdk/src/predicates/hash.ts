import {
  PredicateParamsError,
  isSha256Hex,
  paramsObject,
  sha256Hex,
  type Predicate,
} from "./core.js";

interface HashMatchesParams {
  sha256: string;
}

// The expected hash is the buyer's (the params), never the escrow's commitment: the worker chose that.
const predicate: Predicate<HashMatchesParams> = {
  name: "hash-matches",
  parseParams(raw) {
    const params = paramsObject("hash-matches", raw, ["sha256"]);
    if (!isSha256Hex(params.sha256)) {
      throw new PredicateParamsError("hash-matches sha256 must be 64 lowercase hex characters");
    }
    return { sha256: params.sha256 };
  },
  evaluate(delivery, params) {
    const actual = sha256Hex(delivery.bytes);
    return Promise.resolve(
      actual === params.sha256
        ? { decision: "pass", reason: `the delivery hashes to ${params.sha256}` }
        : { decision: "fail", reason: `the delivery hashes to ${actual}, not ${params.sha256}` },
    );
  },
};

export const hashMatches: Predicate = predicate;
