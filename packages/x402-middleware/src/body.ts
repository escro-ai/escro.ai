// One parsing rule for every adapter: one request yields one TaskSpec, and one spec hash, whichever adapter served it.

export const isJsonMediaType = (contentType: string | null | undefined): boolean =>
  contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";

export type BodyRead =
  | { kind: "ok"; value: unknown }
  | { kind: "too_large" }
  | { kind: "unreadable" };

/** Reads at most `maxBytes` of the request's body and applies the parsing rule. */
export async function readBody(request: Request, maxBytes: number): Promise<BodyRead> {
  // A parser's value carries only the bytes it decoded; the declared length still counts the raw ones.
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return { kind: "too_large" };
  if (request.body === null) return { kind: "ok", value: undefined };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }
  if (total === 0) return { kind: "ok", value: undefined };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!isJsonMediaType(request.headers.get("content-type"))) return { kind: "ok", value: text };
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unreadable" };
  }
}
