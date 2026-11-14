import { canonicalize } from "@escro/shared";

import {
  PredicateParamsError,
  jcs,
  jsonRefusal,
  paramsObject,
  pointerTo,
  utf8,
  type Predicate,
} from "./core.js";

const TYPES = ["null", "boolean", "object", "array", "number", "integer", "string"] as const;
type JsonType = (typeof TYPES)[number];

/** A compiled subschema of the subset; `properties` is a Map so no member name meets a prototype. */
interface Subschema {
  type?: JsonType;
  required?: string[];
  properties?: Map<string, Subschema>;
  additionalProperties?: boolean;
  enum?: Set<string>;
  minimum?: number;
  maximum?: number;
  items?: Subschema;
}

interface JsonSchemaParams {
  schema: Subschema;
}

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description"]);
const MAX_DEPTH = 32;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(message: string): never {
  throw new PredicateParamsError(`json-schema ${message}`);
}

// Fails closed: a keyword outside the subset, or a supported keyword in another form,
// is refused, so no schema is half-read. `pattern` is refused too: a counterparty's regex run in
// the buyer's process could hang it past the 24 h auto-release.
function compile(schema: unknown, pointer: string, depth: number): Subschema {
  if (depth > MAX_DEPTH) {
    refuse(`nests deeper than ${String(MAX_DEPTH)} subschemas at ${pointer}`);
  }
  if (!isObject(schema)) refuse(`subschema at ${pointer} is not an object`);
  const out: Subschema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    const at = pointerTo(pointer, keyword);
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case "type":
        if (typeof value !== "string" || !(TYPES as readonly string[]).includes(value)) {
          refuse(`type at ${at} must be one of ${TYPES.join(", ")}`);
        }
        out.type = value as JsonType;
        break;
      case "required":
        if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
          refuse(`required at ${at} must be an array of member names`);
        }
        out.required = value;
        break;
      case "properties": {
        if (!isObject(value)) refuse(`properties at ${at} must be an object`);
        const properties = new Map<string, Subschema>();
        for (const [name, sub] of Object.entries(value)) {
          properties.set(name, compile(sub, pointerTo(at, name), depth + 1));
        }
        out.properties = properties;
        break;
      }
      case "additionalProperties":
        if (typeof value !== "boolean") {
          refuse(`additionalProperties at ${at} must be a boolean`);
        }
        out.additionalProperties = value;
        break;
      case "enum":
        if (!Array.isArray(value)) refuse(`enum at ${at} must be an array`);
        out.enum = new Set(value.map((member) => jcs(member)));
        break;
      case "minimum":
      case "maximum":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          refuse(`${keyword} at ${at} must be a finite number`);
        }
        out[keyword] = value;
        break;
      case "items":
        if (Array.isArray(value)) refuse(`items at ${at} must be one schema, not an array`);
        out.items = compile(value, at, depth + 1);
        break;
      default:
        refuse(`does not support the keyword ${keyword} (at ${at})`);
    }
  }
  return out;
}

function typeOf(value: unknown): JsonType[] {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  switch (typeof value) {
    case "boolean":
      return ["boolean"];
    case "number":
      return Number.isInteger(value) ? ["number", "integer"] : ["number"];
    case "string":
      return ["string"];
    default:
      return ["object"];
  }
}

/**
 * The first violation of `schema` by `value`, or null. Recursion follows the schema's bounded depth;
 * `value` has passed {@link jsonRefusal}, so the `canonicalize` at an enum is bounded too.
 */
function violation(value: unknown, schema: Subschema, pointer: string): string | null {
  const at = pointer === "" ? "/" : pointer;
  if (schema.type !== undefined && !typeOf(value).includes(schema.type)) {
    return `${at} is not of type ${schema.type}`;
  }
  // The instance passed jsonRefusal (finite numbers, well-formed text, bounded depth), so
  // canonicalize equals jcs over it; the enum members passed jcs when the schema was compiled.
  if (schema.enum !== undefined && !schema.enum.has(canonicalize(value))) {
    return `${at} is not one of the enum values`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${at} is below the minimum ${String(schema.minimum)}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${at} is above the maximum ${String(schema.maximum)}`;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const found = violation((value as unknown[])[i], schema.items, pointerTo(pointer, i));
      if (found !== null) return found;
    }
  }
  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) return `${at} lacks the required member ${name}`;
    }
    for (const name of Object.keys(value)) {
      const sub = schema.properties?.get(name);
      if (sub !== undefined) {
        const found = violation(value[name], sub, pointerTo(pointer, name));
        if (found !== null) return found;
      } else if (schema.additionalProperties === false) {
        return `${at} has the member ${name}, outside properties`;
      }
    }
  }
  return null;
}

const predicate: Predicate<JsonSchemaParams> = {
  name: "json-schema",
  parseParams(raw) {
    const params = paramsObject("json-schema", raw, ["schema"]);
    return { schema: compile(params.schema, "/schema", 0) };
  },
  evaluate(delivery, params) {
    const text = utf8(delivery.bytes);
    if (text === null) {
      return Promise.resolve({ decision: "fail", reason: "the delivery is not UTF-8" });
    }
    let instance: unknown;
    try {
      instance = JSON.parse(text);
    } catch {
      return Promise.resolve({ decision: "fail", reason: "the delivery is not JSON" });
    }
    const refused = jsonRefusal(instance);
    if (refused !== null) {
      return Promise.resolve({
        decision: "fail",
        reason: `the delivery is not RFC 8785 JSON: ${refused}`,
      });
    }
    const found = violation(instance, params.schema, "");
    return Promise.resolve(
      found === null
        ? { decision: "pass", reason: "the delivery validates against the schema" }
        : { decision: "fail", reason: found },
    );
  },
};

export const jsonSchema: Predicate = predicate;
