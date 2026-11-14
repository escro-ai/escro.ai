// EscroBots worker-picker: finds candidate workers in the permissionless directory.
//
// Discovery, not endorsement. A registry entry is a self-reported CLAIM: it says
// a wallet advertised a capability, nothing more. This module keeps two things
// deliberately UNMERGED:
//   - the CLAIM: the descriptor (capabilities, serviceRef, pricingHint).
//   - the AUTHORSHIP check: `signatureValid`, i.e. the descriptor really was
//     signed by that wallet, so a third party did not forge the claim. It does
//     NOT mean the worker can do the work.
// Whether the worker is actually good is verified by ON-CHAIN HISTORY (EscroRep)
// and, ultimately, by YOUR review.ts: the buyer is the judge. This module does no
// ranking or scoring, since the directory is an open index and not a curated
// marketplace: candidates come back in registry order for your bot to choose.

import type { WorkerCandidate } from "@escro/sdk";

/** The subset of the Escro SDK the picker uses (a real `Escro` satisfies it). */
export interface PickerClient {
  findWorkers(params: { capability?: string }): Promise<WorkerCandidate[]>;
}

/**
 * List worker claims in EscroBots for `capability`. The SDK forces `role=worker`
 * (which includes `both` bots) and returns candidates in registry order, each
 * keeping the claim (`descriptor`) separate from the authorship check
 * (`signatureValid`). No ranking is applied.
 */
export async function listWorkerClaims(
  client: PickerClient,
  capability: string,
): Promise<WorkerCandidate[]> {
  return client.findWorkers({ capability });
}

/**
 * Mechanically select the FIRST candidate whose signature verifies (authentic
 * authorship), in registry order. Capabilities remain an unverified claim: this
 * does not vouch for quality; your review.ts does. Returns null when no authentic
 * candidate exists. A real buyer bot may replace this with its own weighting over
 * the candidate list (consumer-side selection is fine; Escro ships no ranking).
 */
export function pickWorker(candidates: WorkerCandidate[]): WorkerCandidate | null {
  return candidates.find((c) => c.signatureValid) ?? null;
}
