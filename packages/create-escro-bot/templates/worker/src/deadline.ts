// Deadline guard: never claim work this bot cannot finish in time.
//
// A worker that claims a job it cannot deliver before the deadline strands the
// buyer's funds until the 24h timeout backstop fires: the backstop is the
// safety net, not the plan. So before claiming, the bot checks it can finish:
//
//   now + estimatedDuration + safetyBuffer <= deadline
//
// `nowSeconds` is injectable so tests are deterministic. The boundary is
// inclusive: finishing exactly at the deadline counts as safe.

export interface DeadlineCheck {
  /** Escrow deadline (Unix seconds): from the on-chain/serialized escrow. */
  deadlineUnix: number;
  /** How long this worker expects the job to take (seconds). */
  estimatedDurationSeconds: number;
  /** Extra margin required before the deadline (seconds). */
  safetyBufferSeconds: number;
  /** Current time (Unix seconds). Injectable for tests. */
  nowSeconds: number;
}

/**
 * Returns true when the bot can finish the job (plus its safety buffer) before
 * the escrow deadline. Refuse to claim when this is false.
 */
export function canFinishBeforeDeadline(check: DeadlineCheck): boolean {
  const finishBy = check.nowSeconds + check.estimatedDurationSeconds + check.safetyBufferSeconds;
  return finishBy <= check.deadlineUnix;
}
