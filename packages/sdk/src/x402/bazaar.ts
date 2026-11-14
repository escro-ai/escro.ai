// A route's `bazaar` declaration (x402 `specs/extensions/bazaar.md` at e4a086819f419e9395acbbdc1679fe6627029ff7),
// built by hand: a discovery catalog reads `info` to call the endpoint and checks it against `schema`.
import type { BazaarDeclaration } from "@escro/shared";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const BODY_METHODS = ["POST", "PUT", "PATCH"];
const QUERY_METHODS = ["GET", "HEAD", "DELETE"];

export interface BuildBazaarDeclarationOptions {
  method: "GET" | "POST";
  /** The example request: the JSON body of a POST, the query parameters of a GET. */
  example: Record<string, unknown>;
  /** The example response. */
  output?: { type: string; example?: unknown };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Where `value` would not come back deep-equal from a JSON round trip; undefined when it would. */
function jsonFault(value: unknown, at: string): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? undefined
      : `${at} is ${String(value)}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) return `${at}[${String(i)}] is a hole`;
      const fault = jsonFault(value[i], `${at}[${String(i)}]`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) return `${at} has a symbol key`;
    for (const [key, member] of Object.entries(value)) {
      const fault = jsonFault(member, `${at}.${key}`);
      if (fault !== undefined) return fault;
    }
    return undefined;
  }
  return `${at} is not JSON (${typeof value})`;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * The `bazaar` declaration of an HTTP route: a POST takes `example` as its JSON body, a GET as its query parameters;
 * the schema requires `input.type` "http" and a method of the route's family. Throws an Error naming `example` when it
 * is not a plain object that survives a JSON round trip, and naming `output.type` when that is empty. The declaration
 * is a copy: a later change to `example` or `output` does not reach it.
 */
export function buildBazaarDeclaration(options: BuildBazaarDeclarationOptions): BazaarDeclaration {
  const { method, example, output } = options;
  if (!isPlainObject(example)) {
    throw new Error("buildBazaarDeclaration: example must be a plain object");
  }
  const exampleFault = jsonFault(example, "example");
  if (exampleFault !== undefined) {
    throw new Error(
      `buildBazaarDeclaration: example must survive a JSON round trip: ${exampleFault}`,
    );
  }
  if (output !== undefined) {
    if (typeof output.type !== "string" || output.type === "") {
      throw new Error("buildBazaarDeclaration: output.type must be a non-empty string");
    }
    const outputFault = jsonFault(output.example, "output.example");
    if (output.example !== undefined && outputFault !== undefined) {
      throw new Error(
        `buildBazaarDeclaration: output.example must survive a JSON round trip: ${outputFault}`,
      );
    }
  }
  const input: BazaarDeclaration["info"]["input"] =
    method === "POST"
      ? { type: "http", method: "POST", bodyType: "json", body: copy(example) }
      : { type: "http", method: "GET", queryParams: copy(example) };
  return {
    info: { input, ...(output === undefined ? {} : { output: copy(output) }) },
    schema: {
      $schema: DRAFT_2020_12,
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { const: "http" },
            method: { enum: method === "POST" ? [...BODY_METHODS] : [...QUERY_METHODS] },
          },
          required: ["type", "method"],
        },
      },
      required: ["input"],
    },
  };
}
