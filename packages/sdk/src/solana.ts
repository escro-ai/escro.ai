import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  CURRENT_ACCOUNT_VERSION,
  ESCROW_INSTRUCTIONS,
  decodeCreateEscrowArgs,
  decodeRaiseDisputeArgs,
  decodeSubmitDeliverableArgs,
  escrowInstructionName,
  getProgramId,
  assertProgramIdNotPlaceholder,
  type EscrowErrorCode,
  type EscrowInstructionName,
  type SolanaCluster,
} from "@escro/shared";
import {
  decodePlatformConfig,
  deriveEscrowPda,
  derivePlatformConfigPda,
} from "@escro/shared/solana";
import { EscroError, attachToError } from "./errors.js";

export function resolveProgramId(cluster: SolanaCluster): PublicKey {
  const id = getProgramId(cluster);
  assertProgramIdNotPlaceholder(id, cluster);
  return new PublicKey(id);
}

function allowedProgramIds(programId: PublicKey): Set<string> {
  return new Set([
    programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  ]);
}

const MAX_INSTRUCTIONS = 6;

/** The SPL Memo program (the current one; the legacy `Memo1Uhk...` program is not admitted). */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * SPL Token tags that move funds or change authority. Escro never has the wallet
 * sign one top-level (token movement is a CPI inside the program), so one in a
 * server-built transaction is a wallet drain (L2).
 */
const FORBIDDEN_TOKEN_IX_TAGS = new Set<number>([
  3, // Transfer
  4, // Approve
  6, // SetAuthority
  7, // MintTo
  8, // Burn
  9, // CloseAccount
  12, // TransferChecked
  13, // ApproveChecked
  14, // MintToChecked
  15, // BurnChecked
]);

/**
 * The mint, treasury and fee rate from the on-chain PlatformConfig. A wrong length,
 * discriminator or version throws rather than returning corrupted values.
 */
export async function fetchPlatformConfig(
  connection: Connection,
  cluster: SolanaCluster,
): Promise<{ mint: PublicKey; treasury: PublicKey; feeBps: number }> {
  const pda = derivePlatformConfigPda(resolveProgramId(cluster));
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error("PlatformConfig account not found on-chain");
  const config = decodePlatformConfig(info.data);
  if (config.version !== CURRENT_ACCOUNT_VERSION) {
    throw new Error(
      `PlatformConfig version mismatch: expected ${String(CURRENT_ACCOUNT_VERSION)}, got ${String(config.version)}`,
    );
  }
  return {
    mint: new PublicKey(config.usdcMint),
    treasury: new PublicKey(config.treasury),
    feeBps: config.feeBps,
  };
}

function refuse(reason: string): never {
  throw new EscroError(
    `Refusing to sign a server-built transaction: ${reason}`,
    "UNEXPECTED_TRANSACTION",
  );
}

export function validateTransaction(tx: Transaction, cluster: SolanaCluster): void {
  validateInstructions(tx.instructions, cluster);
}

function validateInstructions(
  instructions: TransactionInstruction[],
  cluster: SolanaCluster,
): void {
  const programId = resolveProgramId(cluster);
  const allowed = allowedProgramIds(programId);
  const tokenProgram = TOKEN_PROGRAM_ID.toBase58();
  for (const ix of instructions) {
    const id = ix.programId.toBase58();
    if (!allowed.has(id)) {
      refuse(`Unexpected program in transaction: ${id}. Allowed: ${[...allowed].join(", ")}`);
    }
    if (id === tokenProgram) {
      const tag = ix.data.length > 0 ? ix.data[0] : undefined;
      if (tag !== undefined && FORBIDDEN_TOKEN_IX_TAGS.has(tag)) {
        throw new EscroError(
          `Refusing to sign a fund-moving SPL Token instruction (tag ${String(tag)}) in a server-built transaction`,
          "UNEXPECTED_TRANSACTION",
        );
      }
    }
  }
  assertInstructionCount(instructions);
}

function assertInstructionCount(instructions: TransactionInstruction[]): void {
  if (instructions.length > MAX_INSTRUCTIONS) {
    refuse(
      `Too many instructions (${String(instructions.length)}). Max allowed: ${String(MAX_INSTRUCTIONS)}`,
    );
  }
}

/** The one escro instruction a transaction must carry before the SDK signs it. */
export type ExpectedTransaction =
  | {
      name: "create_escrow";
      escrowPda: string;
      taskId: string;
      amount: bigint;
      deadline: bigint;
      specHash: string;
      assignedWorker: string;
    }
  | { name: "claim_task" | "cancel_escrow"; escrowPda: string }
  | {
      name: "release_payment";
      escrowPda: string;
      worker: string;
      treasury: string;
      mint: string;
      /** The decision memo `releaseWithPredicate` computed; the release must end with exactly it. */
      memo?: string;
    }
  | {
      name: "submit_deliverable";
      escrowPda: string;
      deliverableHash: string;
      proofUri: string | null;
    }
  | { name: "raise_dispute"; escrowPda: string; reason: string };

// The idempotent ATA creates the SDK's own release carries: the worker's and the treasury's, for
// the PlatformConfig mint, paid by the wallet.
function releaseAtaCreates(
  wallet: PublicKey,
  expected: Extract<ExpectedTransaction, { name: "release_payment" }>,
): TransactionInstruction[] {
  const mint = new PublicKey(expected.mint);
  return [expected.worker, expected.treasury].map((key) => {
    const owner = new PublicKey(key);
    return createAssociatedTokenAccountIdempotentInstruction(
      wallet,
      getAssociatedTokenAddressSync(mint, owner, true),
      owner,
      mint,
    );
  });
}

function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  return (
    a.programId.equals(b.programId) &&
    a.data.equals(b.data) &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, i) => b.keys[i]?.pubkey.equals(key.pubkey) === true)
  );
}

function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [],
    data: Buffer.from(memo, "utf8"),
  });
}

/**
 * The instructions before an expected release's decision memo. The whole transaction is held to
 * the instruction cap first; the memo must be the last instruction, under the current Memo
 * program, with no accounts and exactly the expected bytes. Any other Memo instruction stays in
 * the prefix, where the program allowlist refuses it.
 */
function beforeExpectedMemo(tx: Transaction, memo: string): TransactionInstruction[] {
  assertInstructionCount(tx.instructions);
  const last = tx.instructions.at(-1);
  const exact =
    last?.programId.toBase58() === MEMO_PROGRAM_ID &&
    last.keys.length === 0 &&
    last.data.equals(Buffer.from(memo, "utf8"));
  if (!exact) refuse("the release does not end with exactly the expected decision memo");
  return tx.instructions.slice(0, -1);
}

/**
 * Refuses a transaction that is not exactly the escro instruction the caller
 * requested: right instruction, escrow, actor, fee payer and arguments, and
 * nothing else beside it except, on a release, at most one idempotent ATA create
 * each for the worker and the treasury, for the expected mint, paid by the wallet,
 * and, on a release expected with a decision memo, that memo as the last instruction.
 * A compromised or impersonated API could otherwise have the wallet sign a
 * different escrow, a create paying another worker, or text it never chose.
 */
export function verifyServerTransaction(
  tx: Transaction,
  cluster: SolanaCluster,
  wallet: PublicKey,
  expected: ExpectedTransaction,
): void {
  const instructions =
    expected.name === "release_payment" && expected.memo !== undefined
      ? beforeExpectedMemo(tx, expected.memo)
      : tx.instructions;
  validateInstructions(instructions, cluster);
  const programId = resolveProgramId(cluster);
  if (!tx.feePayer?.equals(wallet)) refuse("the fee payer is not the wallet");

  const escro = instructions.filter((ix) => ix.programId.equals(programId));
  const others = instructions.filter((ix) => !ix.programId.equals(programId));
  const allowed = expected.name === "release_payment" ? releaseAtaCreates(wallet, expected) : [];
  for (const ix of others) {
    const match = allowed.findIndex((create) => sameInstruction(create, ix));
    if (match === -1) refuse(`unexpected ${ix.programId.toBase58()} instruction`);
    allowed.splice(match, 1);
  }
  if (escro.length !== 1) refuse(`${String(escro.length)} escro instructions, expected 1`);
  const [ix] = escro;
  if (ix === undefined) refuse("no escro instruction");

  const name: EscrowInstructionName | null = escrowInstructionName(ix.data);
  if (name !== expected.name)
    refuse(`${name ?? "an unknown instruction"}, expected ${expected.name}`);
  const spec = ESCROW_INSTRUCTIONS[name];
  const actor = ix.keys[spec.signerAccountIndex];
  if (actor === undefined || !actor.pubkey.equals(wallet) || !actor.isSigner) {
    refuse("the acting signer is not the wallet");
  }
  if (ix.keys[spec.escrowAccountIndex]?.pubkey.toBase58() !== expected.escrowPda) {
    refuse(`the escrow is not ${expected.escrowPda}`);
  }

  try {
    switch (expected.name) {
      case "create_escrow": {
        const args = decodeCreateEscrowArgs(ix.data);
        if (args.taskId !== expected.taskId) refuse("the task id differs");
        if (deriveEscrowPda(programId, wallet, args.taskId).toBase58() !== expected.escrowPda) {
          refuse("the escrow is not derived from the wallet and task id");
        }
        if (args.amount !== expected.amount) refuse("the amount differs");
        if (args.deadline !== expected.deadline) refuse("the deadline differs");
        if (args.specHash !== expected.specHash) refuse("the spec hash differs");
        if (args.assignedWorker !== expected.assignedWorker) refuse("the assigned worker differs");
        break;
      }
      case "submit_deliverable": {
        const args = decodeSubmitDeliverableArgs(ix.data);
        if (args.deliverableHash !== expected.deliverableHash)
          refuse("the deliverable hash differs");
        if (args.proofUri !== expected.proofUri) refuse("the proof URI differs");
        break;
      }
      case "raise_dispute":
        if (decodeRaiseDisputeArgs(ix.data).reason !== expected.reason)
          refuse("the reason differs");
        break;
      default:
        if (ix.data.length !== ESCROW_INSTRUCTIONS[name].discriminator.length) {
          refuse(`${name} carries unexpected arguments`);
        }
    }
  } catch (err) {
    if (err instanceof EscroError) throw err;
    refuse(`malformed ${name} arguments`);
  }
}

const NOT_AN_ERROR = "The RPC rejected with a value that is not an Error";
const TRANSACTION_ERROR_VARIANT = /^[A-Z][A-Za-z0-9]*$/;

/** The Error a non-Error rejection becomes, keeping the value as its `cause`. */
function notAnError(value: unknown): Error {
  return new Error(NOT_AN_ERROR, { cause: value });
}

function executionFailed(signature: string, transactionError: unknown): EscroError {
  return new EscroError(
    `Transaction ${signature} failed at execution: ${JSON.stringify(transactionError)}`,
    "TX_FAILED" satisfies EscrowErrorCode,
  );
}

/**
 * The JSON of `value` when it has the shape of a web3.js `TransactionError`: a unit-variant name, or a plain
 * object with one variant-named key; null for anything else, a value `JSON.stringify` cannot encode included.
 */
function transactionErrorJson(value: unknown): string | null {
  if (typeof value === "string") {
    return TRANSACTION_ERROR_VARIANT.test(value) ? JSON.stringify(value) : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  const [key] = keys;
  if (keys.length !== 1 || typeof key !== "string" || !TRANSACTION_ERROR_VARIANT.test(key)) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    // A cycle or a BigInt: no RPC answers that, so it is not a transaction error.
    return null;
  }
}

/**
 * Settle a confirmation that rejected with a transaction error. web3.js rejects with the error a status check
 * saw at any commitment, so it is final only once a status read sees it at `confirmed` or deeper.
 */
async function settleByStatus(
  connection: Connection,
  signature: string,
  rejected: unknown,
  failure: string,
): Promise<string> {
  const read = await connection
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .then(
      ({ value }) => ({ entry: value[0] ?? null }),
      () => null,
    );
  // A failed read says nothing about the transaction: the confirmation's own value is the cause.
  if (read === null) throw notAnError(rejected);
  const { entry } = read;
  const level = entry?.confirmationStatus;
  if (entry !== null && (level === "confirmed" || level === "finalized")) {
    if (entry.err !== null) throw executionFailed(signature, entry.err);
    return signature;
  }
  throw new Error(
    `Transaction ${signature} failed at execution at processed level, not yet confirmed: ${failure}`,
    { cause: rejected },
  );
}

/**
 * Decode a base64 unsigned transaction, check it is exactly `expected`, sign it
 * with `wallet`, submit it, and return the signature once confirmed. A transaction
 * that landed but failed at execution, seen at `confirmed` or deeper, throws an {@link EscroError}
 * with code `TX_FAILED`. A failure the RPC's status check reports during confirmation is read once
 * more with `getSignatureStatuses`: `TX_FAILED` when that read sees it at `confirmed` or deeper,
 * success when it sees the transaction succeed there, and an `Error` with no code whose message
 * names the signature and the failure at processed level, the failure as its `cause`, when the read
 * sees it unseen or at processed. When that read itself fails, the rejection is the `Error` with
 * the fixed message that a non-Error value gets, its `cause` the confirmation's value; the read's
 * own error is not surfaced.
 * `onSend` runs immediately before the transaction is handed to the RPC: a failure before it
 * means the transaction was never sent. With `wait` false the signature is returned once the RPC
 * accepts the transaction, unconfirmed. Every rejection from the send onward is an `Error`: an
 * `Error` from the send or the confirmation is rethrown as itself, and any other value becomes an
 * `Error` whose `cause` is that value. It carries the transaction's own signature as an own `signature` property.
 */
export async function signAndSend(
  base64Tx: string,
  wallet: Keypair,
  connection: Connection,
  cluster: SolanaCluster,
  expected: ExpectedTransaction,
  onSend?: () => void,
  wait = true,
): Promise<string> {
  const tx = Transaction.from(Buffer.from(base64Tx, "base64"));
  verifyServerTransaction(tx, cluster, wallet.publicKey, expected);
  tx.partialSign(wallet);
  const raw = tx.serialize();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  onSend?.();
  try {
    const signature = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
    });
    if (!wait) return signature;
    let value: { err: unknown };
    try {
      ({ value } = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      ));
    } catch (err) {
      const failure = err instanceof Error ? null : transactionErrorJson(err);
      if (failure === null) throw err;
      return await settleByStatus(connection, signature, err, failure);
    }
    if (value.err !== null) throw executionFailed(signature, value.err);
    return signature;
  } catch (err) {
    const thrown = err instanceof Error ? err : notAnError(err);
    if (tx.signature !== null) attachToError(thrown, "signature", bs58.encode(tx.signature));
    throw thrown;
  }
}

/** An unsigned `release_payment` the buyer signs; account order is the IDL's `ReleasePayment`. */
export async function buildReleasePaymentTx(params: {
  buyer: PublicKey;
  escrowPda: PublicKey;
  worker: PublicKey;
  mint: PublicKey;
  treasury: PublicKey;
  connection: Connection;
  cluster: SolanaCluster;
  /** The decision memo, appended as one SPL Memo instruction after `release_payment`. */
  memo?: string;
}): Promise<string> {
  const { buyer, escrowPda, worker, mint, treasury, connection, cluster, memo } = params;
  const programId = resolveProgramId(cluster);

  const platformConfig = derivePlatformConfigPda(programId);
  const vault = getAssociatedTokenAddressSync(
    mint,
    escrowPda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const workerAta = getAssociatedTokenAddressSync(
    mint,
    worker,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  // The treasury is a Squads vault, a PDA: an off-curve owner must be allowed.
  const treasuryAta = getAssociatedTokenAddressSync(
    mint,
    treasury,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const ix = new TransactionInstruction({
    programId: programId,
    keys: [
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: platformConfig, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: workerAta, isSigner: false, isWritable: true },
      { pubkey: treasuryAta, isSigner: false, isWritable: true },
      { pubkey: worker, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ESCROW_INSTRUCTIONS.release_payment.discriminator),
  });

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = buyer;

  tx.add(createAssociatedTokenAccountIdempotentInstruction(buyer, workerAta, worker, mint));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(buyer, treasuryAta, treasury, mint));
  tx.add(ix);
  if (memo !== undefined) tx.add(memoInstruction(memo));
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}
