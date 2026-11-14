import type { VersionedTransactionResponse } from "@solana/web3.js";

import type { SettlementCause } from "./types/escrow.js";

/**
 * The single escrow-instruction table: every instruction that acts on one
 * escrow account, with its Anchor discriminator, the account indices of the
 * escrow PDA and the signing actor, and the settlement cause for the settling
 * instructions (null for the lifecycle ones). A test locks it to the program's
 * committed IDL. Remaining per-package copies migrate here.
 */
export const ESCROW_INSTRUCTION_NAMES = [
  "create_escrow",
  "claim_task",
  "submit_deliverable",
  "raise_dispute",
  "cancel_escrow",
  "release_payment",
  "timeout_release",
  "refund_buyer",
  "arbitration_release",
  "arbitration_refund",
] as const;

export type EscrowInstructionName = (typeof ESCROW_INSTRUCTION_NAMES)[number];

export interface EscrowInstructionSpec {
  readonly discriminator: Uint8Array;
  readonly escrowAccountIndex: number;
  readonly signerAccountIndex: number;
  readonly cause: SettlementCause | null;
}

function spec(
  discriminator: number[],
  escrowAccountIndex: number,
  cause: SettlementCause | null,
): EscrowInstructionSpec {
  return {
    discriminator: Uint8Array.from(discriminator),
    escrowAccountIndex,
    signerAccountIndex: 0,
    cause,
  };
}

export const ESCROW_INSTRUCTIONS: Readonly<Record<EscrowInstructionName, EscrowInstructionSpec>> = {
  create_escrow: spec([253, 215, 165, 116, 36, 108, 68, 80], 4, null),
  claim_task: spec([49, 222, 219, 238, 155, 68, 221, 136], 1, null),
  submit_deliverable: spec([38, 137, 64, 44, 237, 11, 125, 101], 1, null),
  raise_dispute: spec([41, 243, 1, 51, 150, 95, 246, 73], 1, null),
  cancel_escrow: spec([156, 203, 54, 179, 38, 72, 33, 21], 3, "CANCELLED"),
  release_payment: spec([24, 34, 191, 86, 145, 160, 183, 233], 3, "EXPLICIT_RELEASE"),
  timeout_release: spec([98, 176, 26, 12, 83, 105, 154, 68], 3, "TIMEOUT_RELEASE"),
  refund_buyer: spec([199, 139, 203, 146, 192, 150, 53, 218], 3, "DEADLINE_REFUND"),
  arbitration_release: spec([118, 157, 141, 26, 104, 117, 94, 229], 4, "ARBITRATION_RELEASE"),
  arbitration_refund: spec([255, 194, 84, 248, 185, 249, 120, 122], 4, "ARBITRATION_REFUND"),
};

/** A landed transaction reduced to what instruction matching needs. */
export interface TransactionView {
  /** Static keys, then loaded writable, then loaded readonly addresses (base58). */
  readonly accountKeys: readonly string[];
  readonly instructions: readonly {
    readonly programIdIndex: number;
    readonly accountKeyIndexes: readonly number[];
    readonly data: Uint8Array;
  }[];
}

export interface EscrowInstructionMatch {
  name: EscrowInstructionName;
  /** The account at the instruction's signer index (base58). */
  signer: string;
  data: Uint8Array;
}

/** The table's entry whose discriminator opens `data`, of any program or escrow; null for none. */
export function escrowInstructionName(data: Uint8Array): EscrowInstructionName | null {
  for (const name of ESCROW_INSTRUCTION_NAMES) {
    const disc = ESCROW_INSTRUCTIONS[name].discriminator;
    if (disc.every((b, i) => data[i] === b)) return name;
  }
  return null;
}

/**
 * Every TOP-LEVEL instruction of `programId` in the transaction whose
 * discriminator is in the table and whose escrow account is `escrowPda`.
 * Instructions reached by CPI are not matched: settlement is classified from
 * top-level instructions only.
 */
export function findEscrowInstructions(
  view: TransactionView,
  opts: { programId: string; escrowPda: string },
): EscrowInstructionMatch[] {
  const matches: EscrowInstructionMatch[] = [];
  for (const ix of view.instructions) {
    if (view.accountKeys[ix.programIdIndex] !== opts.programId) continue;
    const name = escrowInstructionName(ix.data);
    if (name === null) continue;
    const entry = ESCROW_INSTRUCTIONS[name];
    const escrowKeyIndex = ix.accountKeyIndexes[entry.escrowAccountIndex];
    const signerKeyIndex = ix.accountKeyIndexes[entry.signerAccountIndex];
    if (escrowKeyIndex === undefined || signerKeyIndex === undefined) continue;
    if (view.accountKeys[escrowKeyIndex] !== opts.escrowPda) continue;
    const signer = view.accountKeys[signerKeyIndex];
    if (signer === undefined) continue;
    matches.push({ name, signer, data: ix.data });
  }
  return matches;
}

interface Base58Key {
  toBase58(): string;
}

/** The fields of a `getTransaction` response that {@link toTransactionView} reads. */
export interface TransactionResponseLike {
  transaction: {
    message: {
      staticAccountKeys: readonly Base58Key[];
      compiledInstructions: readonly {
        programIdIndex: number;
        accountKeyIndexes: readonly number[];
        data: Uint8Array;
      }[];
    };
  };
  meta: {
    loadedAddresses?: { writable: readonly Base58Key[]; readonly: readonly Base58Key[] };
  } | null;
}

// A web3 VersionedTransactionResponse is accepted as-is.
type _AcceptsWeb3Response = VersionedTransactionResponse extends TransactionResponseLike
  ? true
  : never;
const _acceptsWeb3Response: _AcceptsWeb3Response = true;
void _acceptsWeb3Response;

/** Adapt a landed (legacy or v0, lookup-table-aware) transaction to a {@link TransactionView}. */
export function toTransactionView(response: TransactionResponseLike): TransactionView {
  const { message } = response.transaction;
  const loaded = response.meta?.loadedAddresses;
  const accountKeys = [
    ...message.staticAccountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ].map((k) => k.toBase58());
  return { accountKeys, instructions: message.compiledInstructions };
}
