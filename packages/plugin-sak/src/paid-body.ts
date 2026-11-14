const MAX_BODY_BYTES = 65_536;
const BODY_TIMEOUT_MS = 30_000;

/**
 * The paid response's body as text, under both bounds, because the SDK's request timer ends at the headers and the
 * worker controls the rest. It never rejects: the payment has landed, so a body that stalls, overruns or breaks is
 * what arrived, marked truncated. The decoder is never flushed after a cut, so a character the cut split is dropped
 * whole.
 */
export async function readPaidBody(
  response: Response,
): Promise<{ body: string; bodyTruncated: boolean }> {
  if (response.body === null) return { body: "", bodyTruncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let room = MAX_BODY_BYTES;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === null) break;
      if (next.done) return { body: body + decoder.decode(), bodyTruncated: false };
      const kept = next.value.subarray(0, room);
      body += decoder.decode(kept, { stream: true });
      room -= kept.byteLength;
      if (kept.byteLength < next.value.byteLength) break;
    }
  } catch {
    // A broken stream is reported below as a truncated body, the payment having landed.
  } finally {
    clearTimeout(timer);
  }
  // Not awaited: the answer no longer depends on the stream, and a worker can stall its cancel too.
  reader.cancel().catch(() => undefined);
  return { body, bodyTruncated: true };
}
