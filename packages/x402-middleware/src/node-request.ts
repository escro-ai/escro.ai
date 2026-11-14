// The Node side of the adapters: a Web Request over an IncomingMessage (or a Fastify payload) whose body is not touched
// until the menu reads it, so a request the menu passes on reaches the next handler unread.
import { isJsonMediaType } from "./body.js";

export interface RawRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}

// Never part of a URL the menu builds: it reads only the pathname and query, and takes every URL from publicUrl.
const PLACEHOLDER_ORIGIN = "http://menu.invalid";

/** Pulls the source only as the menu reads, stopping at each chunk. */
export function lazyBody(source: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  let detach: (() => void) | undefined;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (detach !== undefined) {
          source.resume();
          return;
        }
        const onData = (chunk: string | Buffer): void => {
          controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          source.pause();
        };
        const onEnd = (): void => {
          detach?.();
          controller.close();
        };
        const onError = (err: Error): void => {
          detach?.();
          controller.error(err);
        };
        const onClose = (): void => {
          onError(new Error("the request closed before its body ended"));
        };
        detach = () => {
          source.off("data", onData);
          source.off("end", onEnd);
          source.off("error", onError);
          source.off("close", onClose);
        };
        source.on("data", onData);
        source.on("end", onEnd);
        source.on("error", onError);
        source.on("close", onClose);
      },
      cancel() {
        detach?.();
        // Drains what is left: Node reuses the connection only once the request has been read to its end.
        source.resume();
      },
    },
    { highWaterMark: 0 },
  );
}

/** A body that fails when read, so the menu answers 400 only for a route it owns. */
function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.error(new Error("the parser's body is not one the menu can use"));
      },
    },
    { highWaterMark: 0 },
  );
}

/** The bytes a parser's value stands for under the menu's parsing rule; undefined for any other shape. */
function bytesOfParsed(
  value: unknown,
  contentType: string | undefined,
): Uint8Array<ArrayBuffer> | undefined {
  if (isJsonMediaType(contentType)) {
    let text: string | undefined;
    try {
      text = JSON.stringify(value) as string | undefined;
    } catch {
      return undefined;
    }
    return text === undefined ? undefined : new TextEncoder().encode(text);
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  return value instanceof Uint8Array ? new Uint8Array(value) : undefined;
}

/** The body a request parsed before the menu carries: `parsed` as bytes, or one that fails when read. */
export function parsedBody(value: unknown, contentType: string | undefined): BodyInit {
  return bytesOfParsed(value, contentType) ?? unreadableBody();
}

/** A Web Request for the menu, whose routes are GET or POST (HEAD reaches a GET route); undefined for any other method. */
export function webRequest(raw: RawRequest, body: () => BodyInit): Request | undefined {
  const { method } = raw;
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return undefined;
  const target = raw.url ?? "/";
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw.headers)) {
    // An HTTP/2 pseudo-header (`:path`, `:authority`, ...) is no header name `Headers` accepts, and the menu reads none.
    if (value !== undefined && !name.startsWith(":")) {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const url = target.startsWith("/") ? `${PLACEHOLDER_ORIGIN}${target}` : target;
  if (method !== "POST") return new Request(url, { method, headers });
  const init: RequestInit & { duplex: "half" } = { method, headers, body: body(), duplex: "half" };
  return new Request(url, init);
}
