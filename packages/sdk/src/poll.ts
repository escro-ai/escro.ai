import { EscroError, EscrowTimeoutError } from "./errors.js";

const MS_5_MIN = 5 * 60 * 1_000;
const MS_30_MIN = 30 * 60 * 1_000;
const MS_24_H = 24 * 60 * 60 * 1_000;

/**
 * Returns the next polling interval in ms based on total elapsed time.
 *   0 – 5 min  →  15 s
 *   5 – 30 min →  30 s
 *  30 min – ∞  →  60 s
 */
export function backoffInterval(elapsedMs: number): number {
  if (elapsedMs < MS_5_MIN) return 15_000;
  if (elapsedMs < MS_30_MIN) return 30_000;
  return 60_000;
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `fetcher` with exponential backoff until `predicate` returns true,
 * then returns the result. Throws {@link EscrowTimeoutError} after 24 hours. A read the API
 * refuses with `RATE_LIMITED` waits its `retryAfterMs` (else the poll interval) and polls again;
 * any other error is thrown.
 *
 * @param address    - Escrow address used in the timeout error message.
 * @param fetcher    - Async function that returns a value or null.
 * @param predicate  - Returns true when polling should stop.
 * @param timeoutMs  - Maximum total wait time in ms (default: 24 h).
 */
export async function pollUntil<T>(
  address: string,
  fetcher: () => Promise<T | null>,
  predicate: (result: T | null) => result is T,
  timeoutMs = MS_24_H,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let result: T | null = null;
    let rateLimited = false;
    let retryAfter: number | undefined;
    try {
      result = await fetcher();
    } catch (err) {
      if (!(err instanceof EscroError) || err.code !== "RATE_LIMITED") throw err;
      rateLimited = true;
      retryAfter = err.retryAfterMs;
    }
    if (!rateLimited && predicate(result)) return result;

    const elapsed = Date.now() - (deadline - timeoutMs);
    if (Date.now() >= deadline) {
      throw new EscrowTimeoutError(address);
    }

    const interval = (rateLimited ? retryAfter : undefined) ?? backoffInterval(elapsed);
    // Clamp to remaining time so we don't sleep past the deadline
    const remaining = deadline - Date.now();
    await sleep(Math.min(interval, remaining));

    if (Date.now() >= deadline) {
      throw new EscrowTimeoutError(address);
    }
  }
}
