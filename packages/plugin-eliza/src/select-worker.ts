import type { ServedWalletReputation, WorkerCandidate } from "@escro/sdk";
import type { EscroClient } from "./client.js";

/**
 * A directory candidate joined to its EscroRep RAW components. The
 * `descriptor`/`signatureValid` pair is unchanged from {@link WorkerCandidate}
 * (a self-reported CLAIM plus an authorship check); `reputation` is that wallet's
 * verified on-chain history, or `null` when the wallet has no Escro history yet.
 * The claim and the verified history are kept as separate fields, never merged
 * into one score.
 */
export interface WorkerWithReputation extends WorkerCandidate {
  /** The wallet's raw EscroRep components, or `null` when it has no on-chain Escro history. */
  reputation: ServedWalletReputation | null;
}

/**
 * A CALLER-SUPPLIED weighting over a candidate's raw components. Escro ships no
 * default weight (Escro-shipped code never ranks) - the
 * caller's own bot owns the policy. A higher number wins.
 */
export type WorkerWeight = (worker: WorkerWithReputation) => number;

/**
 * List directory workers and join each to its EscroRep raw components. The
 * reputation join uses ONE bulk export fetch (`Escro.listReputations`) regardless
 * of candidate count - the per-wallet endpoint shares a 10/min public-metrics
 * budget, so a per-candidate fan-out would rate-limit itself. Registry order is
 * preserved; no ranking or reordering happens here. Weighting/selection is the
 * caller's ({@link selectWorker}).
 */
export async function findWorkersWithReputation(
  client: EscroClient,
  params: { capability?: string } = {},
): Promise<WorkerWithReputation[]> {
  const [candidates, reputations] = await Promise.all([
    client.findWorkers(params),
    client.listReputations(),
  ]);
  const byWallet = new Map(reputations.map((rep) => [rep.wallet, rep]));
  return candidates.map((candidate) => ({
    ...candidate,
    reputation: byWallet.get(candidate.descriptor.wallet) ?? null,
  }));
}

/**
 * Select the highest-weighted worker under the caller's `weight`. Ties preserve
 * input (registry) order - the strict `>` never lets a later, equal candidate
 * displace an earlier one, so Escro imposes no tie-break opinion of its own. The
 * raw components are handed to `weight` untransformed (no normalization or
 * pre-scoring). Returns `undefined` only for an empty candidate set.
 */
export function selectWorker(
  workers: WorkerWithReputation[],
  weight: WorkerWeight,
): WorkerWithReputation | undefined {
  let best: WorkerWithReputation | undefined;
  // Not a floor: the `best === undefined` guard seeds best (and bestScore) on the
  // first iteration, so negative weights select normally; the 0 only satisfies
  // TypeScript's definite-assignment before that first pass.
  let bestScore = 0;
  for (const worker of workers) {
    const score = weight(worker);
    if (best === undefined || score > bestScore) {
      best = worker;
      bestScore = score;
    }
  }
  return best;
}
