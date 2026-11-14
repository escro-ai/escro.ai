// The only signer the `exact` client ever holds. It decodes the one transaction it is asked to sign
// and checks it against the chosen entry and the caller's own terms before the key runs. It
// constrains what the official client can get signed; it is not an isolation boundary against a
// compromised dependency in the same realm.
import {
  ComputeBudgetProgram,
  PublicKey,
  VersionedMessage,
  type Keypair,
  type MessageCompiledInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { getUsdcMint, type PaymentRequirements, type SolanaCluster } from "@escro/shared";
import type {
  Address,
  SignatureBytes,
  SignatureDictionary,
  TransactionPartialSigner,
} from "@solana/kit";

import { EscroPayError } from "../errors.js";
import { MEMO_PROGRAM_ID } from "../solana.js";

const SET_COMPUTE_UNIT_LIMIT = { tag: 2, length: 5 };
const SET_COMPUTE_UNIT_PRICE = { tag: 3, length: 9 };
// The cap of the scheme spec pinned for @x402/svm 2.29.0. Conformance, not fund protection: the fee
// payer is checked not to be the wallet.
const MAX_COMPUTE_UNIT_PRICE = 5_000_000n;

const TRANSFER_CHECKED = { tag: 12, length: 10, accounts: 4 };
const USDC_DECIMALS = 6;

// The transaction is [SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked, Memo]; the wallet's
// one permitted account position is the authority of that transfer.
const TRANSFER_INDEX = 2;
const TRANSFER_AUTHORITY_POSITION = 3;

function refuse(detail: string, why: string, cause?: unknown): never {
  throw new EscroPayError("transaction", `Refusing to sign the x402 transaction: ${why}`, {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The data as UTF-8 text, byte-exact (a leading BOM is kept), or undefined when it is not UTF-8. */
function utf8Text(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
}

function decode(bytes: Uint8Array): VersionedMessage {
  try {
    return VersionedMessage.deserialize(bytes);
  } catch (cause) {
    return refuse("decode", "the message does not decode", cause);
  }
}

/** Whether the decoded message writes back to exactly `bytes`: parsers disagree on anything else. */
function isCanonical(message: VersionedMessage, bytes: Uint8Array): boolean {
  try {
    return Buffer.from(message.serialize()).equals(bytes);
  } catch {
    return false;
  }
}

function assertComputeBudget(
  ix: MessageCompiledInstruction,
  shape: { tag: number; length: number },
  name: string,
): void {
  if (ix.data[0] !== shape.tag || ix.data.length !== shape.length) {
    refuse("compute_budget", `the compute-budget instruction is not ${name}`);
  }
}

/** Checks `bytes` in the documented order and returns the Memo text. */
function checkMessage(
  bytes: Uint8Array,
  entry: PaymentRequirements,
  wallet: PublicKey,
  cluster: SolanaCluster,
): string {
  const message = decode(bytes);
  if (!isCanonical(message, bytes)) refuse("non_canonical", "the message is not canonical");
  if (message.version !== 0) refuse("version", "the message is not version 0");
  if (message.header.numRequiredSignatures !== 2) {
    refuse("header", "the message does not require exactly two signatures");
  }

  const keys = message.staticAccountKeys;
  if (keys[0]?.toBase58() !== entry.extra?.feePayer) {
    refuse("fee_payer", "the fee payer is not the entry's feePayer");
  }
  if (keys[1]?.equals(wallet) !== true) {
    refuse("wallet_position", "the second signer is not the wallet");
  }
  message.compiledInstructions.forEach((ix, index) => {
    ix.accountKeyIndexes.forEach((keyIndex, position) => {
      const isAuthority = index === TRANSFER_INDEX && position === TRANSFER_AUTHORITY_POSITION;
      if (keys[keyIndex]?.equals(wallet) === true && !isAuthority) {
        refuse("wallet_position", "the wallet appears other than as the transfer's authority");
      }
    });
  });
  if (message.addressTableLookups.length !== 0) {
    refuse("lookup_table", "the message has address table lookups");
  }

  const [limit, price, transfer, memo, ...rest] = message.compiledInstructions;
  const programOf = (ix: MessageCompiledInstruction | undefined): PublicKey | undefined =>
    ix === undefined ? undefined : keys[ix.programIdIndex];
  const transferProgram = programOf(transfer);
  if (
    limit === undefined ||
    price === undefined ||
    transfer === undefined ||
    memo === undefined ||
    rest.length !== 0 ||
    programOf(limit)?.equals(ComputeBudgetProgram.programId) !== true ||
    programOf(price)?.equals(ComputeBudgetProgram.programId) !== true ||
    // Token-2022 passes here for the transfer check below to name it.
    (transferProgram?.equals(TOKEN_PROGRAM_ID) !== true &&
      transferProgram?.equals(TOKEN_2022_PROGRAM_ID) !== true) ||
    programOf(memo)?.toBase58() !== MEMO_PROGRAM_ID
  ) {
    return refuse("instruction_list", "the instructions are not the exact scheme's four");
  }

  assertComputeBudget(limit, SET_COMPUTE_UNIT_LIMIT, "SetComputeUnitLimit");
  assertComputeBudget(price, SET_COMPUTE_UNIT_PRICE, "SetComputeUnitPrice");
  if (Buffer.from(price.data).readBigUInt64LE(1) > MAX_COMPUTE_UNIT_PRICE) {
    refuse("compute_price", "the compute-unit price is over the scheme's cap");
  }

  if (
    !transferProgram.equals(TOKEN_PROGRAM_ID) ||
    transfer.data[0] !== TRANSFER_CHECKED.tag ||
    transfer.data.length !== TRANSFER_CHECKED.length ||
    transfer.accountKeyIndexes.length !== TRANSFER_CHECKED.accounts
  ) {
    refuse("transfer_shape", "the transfer is not a classic Token TransferChecked");
  }
  const transferKey = (position: number): PublicKey | undefined => {
    const keyIndex = transfer.accountKeyIndexes[position];
    return keyIndex === undefined ? undefined : keys[keyIndex];
  };
  const mint = new PublicKey(getUsdcMint(cluster));
  if (transferKey(1)?.equals(mint) !== true) refuse("mint", "the mint is not the cluster's USDC");
  if (transferKey(0)?.equals(getAssociatedTokenAddressSync(mint, wallet)) !== true) {
    refuse("source", "the source is not the wallet's token account");
  }
  const destination = getAssociatedTokenAddressSync(mint, new PublicKey(entry.payTo), true);
  if (transferKey(2)?.equals(destination) !== true) {
    refuse("destination", "the destination is not payTo's token account");
  }
  if (transferKey(TRANSFER_AUTHORITY_POSITION)?.equals(wallet) !== true) {
    refuse("authority", "the transfer's authority is not the wallet");
  }
  if (Buffer.from(transfer.data).readBigUInt64LE(1) !== BigInt(entry.amount)) {
    refuse("amount", "the amount is not the entry's");
  }
  if (transfer.data[9] !== USDC_DECIMALS) refuse("decimals", "the decimals are not USDC's");

  if (memo.accountKeyIndexes.length !== 0) refuse("memo", "the Memo carries accounts");
  const text = utf8Text(memo.data);
  if (text === undefined) return refuse("memo", "the Memo is not valid UTF-8");
  const required = entry.extra?.memo;
  const matches = typeof required === "string" && Buffer.from(required, "utf8").equals(memo.data);
  if (required !== undefined && !matches) refuse("memo", "the Memo is not the entry's");
  return text;
}

/**
 * A signer for one `exact` payment: one call, one transaction. `messageBytes` is copied once and
 * that copy is decoded, checked and signed synchronously. `onSigned` receives the Memo text before
 * the signature is computed, so the rail never credits back a payment whose signature may exist.
 */
export function guardedSigner(
  wallet: Keypair,
  requirements: PaymentRequirements,
  cluster: SolanaCluster,
  onSigned?: (memo: string) => void,
): TransactionPartialSigner {
  const address = wallet.publicKey.toBase58() as Address;
  let called = false;
  const signOnce: (
    transactions: Parameters<TransactionPartialSigner["signTransactions"]>[0],
  ) => readonly SignatureDictionary[] = (transactions) => {
    const again = called;
    called = true;
    const [transaction] = transactions;
    if (again || transaction === undefined || transactions.length !== 1) {
      return refuse("batch", "the signer signs one transaction, once");
    }
    const bytes = Uint8Array.from(transaction.messageBytes);
    const memo = checkMessage(bytes, requirements, wallet.publicKey, cluster);
    onSigned?.(memo);
    const signature = nacl.sign.detached(bytes, wallet.secretKey) as SignatureBytes;
    return [Object.freeze({ [address]: signature })];
  };
  return Object.freeze({
    address,
    signTransactions: (transactions) =>
      new Promise<readonly SignatureDictionary[]>((resolve) => {
        resolve(signOnce(transactions));
      }),
  });
}
