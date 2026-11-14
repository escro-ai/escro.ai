import type { OutstandingDeposits, SolanaCluster } from "@escro/shared";
import { API_REQUEST_TIMEOUT_MS } from "./api.js";
import { EscroError } from "./errors.js";
import type { X402SpendCap } from "./types.js";

/**
 * One wallet's spend-capped creates on one cluster, shared by every `Escro` in the process.
 * Admissions run one at a time; `pending` holds each admitted create's deposit by escrow address
 * from its POST until evidence shows the API counts it or that its transaction never landed.
 */
export interface WalletLedger {
  admissions: Promise<unknown>;
  readonly pending: Map<string, PendingCreate>;
}

/** An admitted create's deposit, and the signature its send returned once the send resolved. */
export interface PendingCreate {
  readonly deposit: bigint;
  signature?: string;
}

/** The `code` of each {@link EscroError} the spend cap throws. */
export const SPEND_CAP_ERROR_CODES = {
  /** A mainnet `createEscrow` on a client constructed without the `spendCap` option. */
  required: "SPEND_CAP_REQUIRED",
  /** The create's deposit would pass the cap. */
  exceeded: "SPEND_CAP_EXCEEDED",
  /** The outstanding deposits could not be read. */
  unreadable: "SPEND_CAP_UNREADABLE",
} as const;

const ledgers = new Map<string, WalletLedger>();

function ledgerKey(cluster: SolanaCluster, wallet: string): string {
  return `${cluster}:${wallet}`;
}

/** The process's ledger for `wallet` on `cluster`. */
export function walletLedger(cluster: SolanaCluster, wallet: string): WalletLedger {
  const key = ledgerKey(cluster, wallet);
  let ledger = ledgers.get(key);
  if (ledger === undefined) {
    ledger = { admissions: Promise.resolve(), pending: new Map() };
    ledgers.set(key, ledger);
  }
  return ledger;
}

/**
 * One wallet's x402 spending on one cluster, shared by every `Escro` in the process. It is a
 * monotonic total, not {@link WalletLedger.pending}'s in-flight set: a signed payment cannot be
 * shown not to have landed, so it never leaves the total. A restart starts it again at zero.
 */
export interface X402Ledger {
  admissions: Promise<unknown>;
  spentMicroUsdc: bigint;
}

const x402Ledgers = new Map<string, X402Ledger>();

/** The process's x402 ledger for `wallet` on `cluster`. */
export function x402Ledger(cluster: SolanaCluster, wallet: string): X402Ledger {
  const key = ledgerKey(cluster, wallet);
  let ledger = x402Ledgers.get(key);
  if (ledger === undefined) {
    ledger = { admissions: Promise.resolve(), spentMicroUsdc: 0n };
    x402Ledgers.set(key, ledger);
  }
  return ledger;
}

/** Forgets the in-flight deposit of `address`, if the wallet's ledger holds one. */
export function dropPending(cluster: SolanaCluster, wallet: string, address: string): void {
  ledgers.get(ledgerKey(cluster, wallet))?.pending.delete(address);
}

/** Records the signature the send of the in-flight create at `address` returned. */
export function recordSent(
  cluster: SolanaCluster,
  wallet: string,
  address: string,
  signature: string,
): void {
  const entry = ledgers.get(ledgerKey(cluster, wallet))?.pending.get(address);
  if (entry !== undefined) entry.signature = signature;
}

/**
 * Forgets the in-flight deposit of `address` on evidence that `signature` landed and failed, only
 * when `signature` is the one its send returned: another transaction for the same address failing
 * says nothing about the create that holds the deposit.
 */
export function dropFailed(
  cluster: SolanaCluster,
  wallet: string,
  address: string,
  signature: string,
): void {
  const pending = ledgers.get(ledgerKey(cluster, wallet))?.pending;
  if (pending?.get(address)?.signature === signature) pending.delete(address);
}

/** Runs `step` after every earlier admission on the ledger has settled, passed or not. */
export function admit<T>(
  ledger: Pick<WalletLedger, "admissions">,
  step: () => Promise<T>,
): Promise<T> {
  const run = ledger.admissions.then(step);
  ledger.admissions = run.catch(() => undefined);
  return run;
}

/**
 * Runs `read`, abandoning it (it takes no signal, so it is not cancelled) if it has not answered
 * within the API read's bound, so a read inside an admission holds the admission no longer.
 */
export async function boundedRead<T>(what: string, read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not answer within ${String(API_REQUEST_TIMEOUT_MS / 1000)} s`));
    }, API_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readX402Spent(cap: Readonly<X402SpendCap>): Promise<bigint> {
  if (cap.spent === undefined) return 0n;
  let value: number;
  try {
    value = await boundedRead("x402SpendCap.spent()", cap.spent);
  } catch (err) {
    throw new EscroError(
      `The x402 spend could not be read: ${err instanceof Error ? err.message : String(err)}`,
      SPEND_CAP_ERROR_CODES.unreadable,
      undefined,
      { cause: err },
    );
  }
  if (!isMicroUsdc(value)) {
    throw unreadable(`x402SpendCap.spent() answered ${String(value)}, not whole micro-USDC`);
  }
  return BigInt(value);
}

/**
 * Admits one x402 payment against `cap`, counting its full amount, and returns the function that
 * credits it back: call it only for a payment refused before its signature exists. Without a cap
 * off mainnet nothing is counted.
 */
export async function admitX402Payment(
  cap: Readonly<X402SpendCap> | undefined,
  cluster: SolanaCluster,
  wallet: string,
  amountMicroUsdc: number,
): Promise<() => void> {
  if (cap === undefined) {
    if (cluster === "mainnet") {
      throw new EscroError(
        "pay() over x402 on mainnet needs a spend cap: construct Escro with the x402SpendCap option.",
        SPEND_CAP_ERROR_CODES.required,
      );
    }
    return () => undefined;
  }
  const ledger = x402Ledger(cluster, wallet);
  const amount = BigInt(amountMicroUsdc);
  return admit(ledger, async () => {
    const recorded = await readX402Spent(cap);
    const total = recorded + ledger.spentMicroUsdc + amount;
    if (total > BigInt(cap.maxMicroUsdc)) {
      throw new EscroError(
        `Spend cap exceeded: spent ${String(recorded + ledger.spentMicroUsdc)} + proposed ` +
          `${String(amount)} micro-USDC would pass the x402SpendCap of ` +
          `${String(cap.maxMicroUsdc)} micro-USDC.`,
        SPEND_CAP_ERROR_CODES.exceeded,
      );
    }
    ledger.spentMicroUsdc += amount;
    return () => {
      ledger.spentMicroUsdc -= amount;
    };
  });
}

/** The sum of the ledger's in-flight deposits. */
export function pendingMicroUsdc(ledger: WalletLedger): bigint {
  let total = 0n;
  for (const { deposit } of ledger.pending.values()) total += deposit;
  return total;
}

/**
 * The micro-USDC in the outstanding-deposits answer for `maker`. An answer for another maker, or
 * whose total is not a decimal string, throws `SPEND_CAP_UNREADABLE`; the caller refuses a total
 * a `number` cannot hold exactly.
 */
export function outstandingFromAnswer(answer: OutstandingDeposits, maker: string): number {
  if (answer.maker !== maker) {
    throw unreadable(
      `the outstanding deposits answer is for ${JSON.stringify(answer.maker)}, not ${maker}`,
    );
  }
  const text: unknown = answer.depositsMicroUsdc;
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    throw unreadable(`the outstanding deposits total ${JSON.stringify(text)} is not a decimal`);
  }
  return Number(text);
}

/**
 * Throws an {@link EscroError} with code `SPEND_CAP_EXCEEDED` when the outstanding deposits plus
 * the proposed one would pass the cap. All three are integer micro-USDC; reaching the cap exactly
 * is allowed.
 */
export function assertWithinSpendCap(check: {
  maxOutstandingMicroUsdc: number;
  outstandingMicroUsdc: number;
  proposedMicroUsdc: number;
}): void {
  const total = BigInt(check.outstandingMicroUsdc) + BigInt(check.proposedMicroUsdc);
  if (total > BigInt(check.maxOutstandingMicroUsdc)) {
    throw new EscroError(
      `Spend cap exceeded: outstanding ${String(check.outstandingMicroUsdc)} + proposed ` +
        `${String(check.proposedMicroUsdc)} micro-USDC would pass the spendCap of ` +
        `${String(check.maxOutstandingMicroUsdc)} micro-USDC.`,
      SPEND_CAP_ERROR_CODES.exceeded,
    );
  }
}

/** Whether `n` is a whole, non-negative micro-USDC amount a `number` holds exactly. */
export function isMicroUsdc(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

function unreadable(message: string): EscroError {
  return new EscroError(message, SPEND_CAP_ERROR_CODES.unreadable);
}

/**
 * A plain decimal USDC amount (`"12.5"`, at most six decimals, no sign or exponent) as integer
 * micro-USDC. Throws an {@link EscroError} with code `VALIDATION_ERROR` otherwise.
 */
export function parseUsdc(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  const micro =
    match === null
      ? undefined
      : Number(BigInt(match[1] ?? "") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0")));
  if (micro === undefined || !Number.isSafeInteger(micro)) {
    throw new EscroError(
      `Not a USDC amount (digits, at most six decimals): ${JSON.stringify(text)}`,
      "VALIDATION_ERROR",
    );
  }
  return micro;
}
