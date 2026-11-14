// The EscroRep wire types the SDK exports: the raw per-wallet components derived from
// Escro's on-chain settlement history. There is no composite score; a consumer weights the
// components itself.

export interface DisputeRecord {
  total: number;
  won: number;
  lost: number;
}

export interface WorkerReputation {
  tasksClaimed: number;
  completions: number;
  completionsViaRelease: number;
  completionsViaTimeout: number;
  nonDeliveries: number;
  completionRate: number | null;
  disputes: DisputeRecord;
  disputeRate: number | null;
  volumeSettledUsdc: bigint;
  avgCreateToClaimSeconds: number | null;
  avgClaimToSubmitSeconds: number | null;
}

export interface BuyerReputation {
  escrowsCreated: number;
  timeoutReleases: number;
  disputes: DisputeRecord;
  disputeRate: number | null;
  volumeSettledUsdc: bigint;
}

export interface WalletReputation {
  wallet: string;
  asWorker: WorkerReputation;
  asBuyer: BuyerReputation;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}

export interface SerializedWalletReputation extends Omit<WalletReputation, "asWorker" | "asBuyer"> {
  asWorker: Omit<WorkerReputation, "volumeSettledUsdc"> & {
    volumeSettledUsdc: string;
  };
  asBuyer: Omit<BuyerReputation, "volumeSettledUsdc"> & {
    volumeSettledUsdc: string;
  };
}

export interface ServedWalletReputation extends SerializedWalletReputation {
  walletAgeSeconds: number | null;
}

export interface ReputationExport {
  wallets: ServedWalletReputation[];
  count: number;
  generatedAt: number;
}
