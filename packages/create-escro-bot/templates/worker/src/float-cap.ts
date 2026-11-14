// Working-capital (float) bound.
//
// A worker fronts the underlying service cost of every job it runs and is only
// reimbursed in USDC when the buyer releases: so running N concurrent jobs ties
// up working capital proportional to their summed service cost. This guard makes
// the bot REFUSE to claim a new job when the summed service-cost estimate of its
// in-flight jobs (plus the new one) would exceed the configured float bound. It
// operationalizes the funding side of "never claim what you cannot finish".
//
// The bound is REQUIRED config (escro.config.ts): there is deliberately no
// default that silently unbounds it. All money math runs in INTEGER micro-USDC
// (USDC has 6 decimals); never do float arithmetic on money.

const MICRO_USDC_PER_USDC = 1_000_000;

/** Convert USDC to integer micro-USDC (6 dp). Rejects non-finite/negative. */
export function usdcToMicro(usdc: number): number {
  if (!Number.isFinite(usdc) || usdc < 0) {
    throw new Error(`Invalid USDC amount: ${String(usdc)}`);
  }
  return Math.round(usdc * MICRO_USDC_PER_USDC);
}

export interface FloatBoundCheck {
  /** The configured working-capital bound, in USDC (from escro.config.ts). */
  maxConcurrentFloatUsdc: number;
  /** Summed service-cost estimate of currently in-flight jobs, in integer micro-USDC. */
  inFlightMicroUsdc: number;
  /** Service-cost estimate of the job being considered, in integer micro-USDC. */
  proposedMicroUsdc: number;
}

/**
 * Throw if claiming the proposed job would push the bot's committed working
 * capital over its float bound. Returns silently when within bound (the bound is
 * inclusive: hitting it exactly is allowed).
 */
export function assertWithinFloatBound(check: FloatBoundCheck): void {
  const boundMicro = usdcToMicro(check.maxConcurrentFloatUsdc);
  const total = check.inFlightMicroUsdc + check.proposedMicroUsdc;
  if (total > boundMicro) {
    throw new Error(
      `Float bound exceeded: in-flight ${String(check.inFlightMicroUsdc)} + proposed ` +
        `${String(check.proposedMicroUsdc)} micro-USDC would exceed the ` +
        `${String(check.maxConcurrentFloatUsdc)} USDC bound.`,
    );
  }
}
