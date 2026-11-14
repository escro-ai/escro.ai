// The transaction versions a chain reader asks for and decodes. web3 1.98's response struct
// accepts only `"legacy"` and 0, while a version-1 message names static account keys only, the
// legacy message shape; so a reader asks the RPC for version 1 and its Connection's fetch presents
// an ok version-1 `getTransaction` result as legacy. A version-1 result naming an address lookup
// or a loaded address keeps its version and web3 refuses it: a reader stops at a transaction it
// cannot read rather than read it differently from the chain. A leaf with no runtime import, so
// it reaches no bundle that does not import `./chain`.

/** The `maxSupportedTransactionVersion` every reader built on {@link transactionVersionFetch} asks. */
export const MAX_SUPPORTED_TRANSACTION_VERSION = 1 as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parsed JSON of `text`, or undefined when it is not JSON (the caller passes it on as is). */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isSingleGetTransaction(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const request = parsedJson(body);
  return isObject(request) && request.method === "getTransaction";
}

const isEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/** Whether `result` is a version-1 transaction whose message names only static account keys. */
function isStaticVersionOne(result: unknown): result is Record<string, unknown> {
  if (!isObject(result) || result.version !== 1) return false;
  const transaction = result.transaction;
  const message = isObject(transaction) ? transaction.message : undefined;
  const lookups = isObject(message) ? message.addressTableLookups : undefined;
  if (lookups !== undefined && !isEmptyList(lookups)) return false;
  const meta = result.meta;
  if (meta === null) return true;
  if (!isObject(meta)) return false;
  const loaded = meta.loadedAddresses;
  if (loaded === undefined) return true;
  return isObject(loaded) && isEmptyList(loaded.writable) && isEmptyList(loaded.readonly);
}

/**
 * `fetchFn` with an ok `getTransaction` result of version 1 that names no address lookup and no
 * loaded address presented as `"legacy"`, nothing else of it changed. Every other request and
 * every non-ok response is `fetchFn`'s own `Response`; any other ok `getTransaction` response is
 * returned unchanged. One `fetchFn` call per call; its rejection propagates as is.
 */
export function transactionVersionFetch(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (!response.ok || !isSingleGetTransaction(init?.body)) return response;
    const parsed = parsedJson(await response.clone().text());
    if (!isObject(parsed) || !isStaticVersionOne(parsed.result)) return response;
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
    return new Response(
      JSON.stringify({ ...parsed, result: { ...parsed.result, version: "legacy" } }),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  };
}
