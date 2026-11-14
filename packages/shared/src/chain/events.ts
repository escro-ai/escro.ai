// The program's event layouts and their decoder, the off-chain copy this package's chain readers
// (the SDK's among them) decode with; the layouts are locked to the program's committed IDL by a
// test, and Anchor's BorshEventCoder decodes the same payloads as an independent second decoder.
import bs58 from "bs58";

import { escrowFee } from "../config.js";

type Scalar = "pubkey" | "string" | "u64" | "i64" | "u16" | "bool";
export type EventFieldType = Scalar | { readonly option: "pubkey" | "string" };

/** Each event's discriminator and Borsh fields, in IDL order with IDL names and types. */
export const ESCRO_EVENT_LAYOUTS = {
  EscrowCreated: {
    discriminator: [70, 127, 105, 102, 92, 97, 7, 173],
    fields: [
      ["escrow", "pubkey"],
      ["buyer", "pubkey"],
      ["task_id", "string"],
      ["amount_usdc", "u64"],
      ["fee_bps", "u16"],
      ["deadline", "i64"],
      ["spec_hash", "string"],
      ["created_at", "i64"],
      ["assigned_worker", { option: "pubkey" }],
      ["marketplace_id", { option: "string" }],
      ["referrer_wallet", { option: "pubkey" }],
      ["referrer_bps", "u16"],
    ],
  },
  TaskClaimed: {
    discriminator: [208, 90, 243, 116, 80, 15, 228, 202],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["claimed_at", "i64"],
      ["assigned_at_creation", "bool"],
      ["marketplace_id", { option: "string" }],
    ],
  },
  DeliverableSubmitted: {
    discriminator: [128, 198, 110, 44, 67, 73, 255, 99],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["deliverable_hash", "string"],
      ["proof_uri", { option: "string" }],
      ["submitted_at", "i64"],
    ],
  },
  DisputeRaised: {
    discriminator: [246, 167, 109, 37, 142, 45, 38, 176],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["disputant", "pubkey"],
      ["reason", "string"],
      ["raised_at", "i64"],
    ],
  },
  EscrowCancelled: {
    discriminator: [98, 241, 195, 122, 213, 0, 162, 161],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["buyer", "pubkey"],
      ["refund_amount", "u64"],
      ["marketplace_id", { option: "string" }],
      ["cancelled_at", "i64"],
    ],
  },
  PaymentReleased: {
    discriminator: [160, 132, 155, 232, 46, 254, 69, 219],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["worker", "pubkey"],
      ["worker_amount", "u64"],
      ["fee_amount", "u64"],
      ["referrer_amount", "u64"],
      ["referrer", { option: "pubkey" }],
      ["marketplace_id", { option: "string" }],
      ["resolved_at", "i64"],
    ],
  },
  BuyerRefunded: {
    discriminator: [146, 238, 116, 115, 63, 254, 107, 176],
    fields: [
      ["escrow", "pubkey"],
      ["task_id", "string"],
      ["buyer", "pubkey"],
      ["refund_amount", "u64"],
      ["marketplace_id", { option: "string" }],
      ["resolved_at", "i64"],
    ],
  },
} as const satisfies Record<
  string,
  {
    discriminator: readonly number[];
    fields: readonly (readonly [string, EventFieldType])[];
  }
>;

export type EscroEventName = keyof typeof ESCRO_EVENT_LAYOUTS;

export const ESCRO_EVENT_NAMES = Object.keys(ESCRO_EVENT_LAYOUTS) as readonly EscroEventName[];

export interface EscrowCreatedEvent {
  name: "EscrowCreated";
  escrow: string;
  buyer: string;
  taskId: string;
  amountUsdc: bigint;
  feeBps: number;
  deadline: number;
  specHash: string;
  createdAt: number;
  assignedWorker: string | null;
}

export interface TaskClaimedEvent {
  name: "TaskClaimed";
  escrow: string;
  taskId: string;
  worker: string;
  claimedAt: number;
}

export interface DeliverableSubmittedEvent {
  name: "DeliverableSubmitted";
  escrow: string;
  taskId: string;
  worker: string;
  deliverableHash: string;
  proofUri: string | null;
  submittedAt: number;
}

export interface DisputeRaisedEvent {
  name: "DisputeRaised";
  escrow: string;
  taskId: string;
  disputant: string;
  reason: string;
  raisedAt: number;
}

export interface EscrowCancelledEvent {
  name: "EscrowCancelled";
  escrow: string;
  taskId: string;
  buyer: string;
  refundAmount: bigint;
  cancelledAt: number;
}

export interface PaymentReleasedEvent {
  name: "PaymentReleased";
  escrow: string;
  taskId: string;
  worker: string;
  workerAmount: bigint;
  feeAmount: bigint;
  resolvedAt: number;
}

export interface BuyerRefundedEvent {
  name: "BuyerRefunded";
  escrow: string;
  taskId: string;
  buyer: string;
  refundAmount: bigint;
  resolvedAt: number;
}

export type EscroEvent =
  | EscrowCreatedEvent
  | TaskClaimedEvent
  | DeliverableSubmittedEvent
  | DisputeRaisedEvent
  | EscrowCancelledEvent
  | PaymentReleasedEvent
  | BuyerRefundedEvent;

/** The amount fields of a settle event. */
export type SettleAmounts =
  | Pick<PaymentReleasedEvent, "name" | "workerAmount" | "feeAmount">
  | Pick<EscrowCancelledEvent, "name" | "refundAmount">
  | Pick<BuyerRefundedEvent, "name" | "refundAmount">;

/**
 * Whether a settle event carries the amounts the program computes for an escrow of `amount` at
 * `feeBps`: a release pays the worker `amount` and the treasury the fee, a cancel or refund
 * returns `amount` plus the fee. Exact bigint arithmetic.
 */
export function settleAmountsMatch(event: SettleAmounts, amount: bigint, feeBps: number): boolean {
  const fee = escrowFee(amount, feeBps);
  return event.name === "PaymentReleased"
    ? event.workerAmount === amount && event.feeAmount === fee
    : event.refundAmount === amount + fee;
}

type FieldValue = string | bigint | number | boolean | null;

class Reader {
  private at = 0;
  constructor(
    private readonly data: Uint8Array,
    private readonly event: string,
  ) {}

  private take(n: number): Uint8Array {
    if (this.at + n > this.data.length) {
      throw new Error(
        `${this.event} payload of ${String(this.data.length)} bytes is truncated at byte ${String(this.at)}`,
      );
    }
    const bytes = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return bytes;
  }

  private view(n: number): DataView {
    const bytes = this.take(n);
    return new DataView(bytes.buffer, bytes.byteOffset, n);
  }

  read(type: EventFieldType): FieldValue {
    if (typeof type !== "string") {
      const tag = this.view(1).getUint8(0);
      if (tag === 0) return null;
      if (tag !== 1) throw new Error(`${this.event}: option tag ${String(tag)} is neither 0 nor 1`);
      return this.read(type.option);
    }
    switch (type) {
      case "pubkey":
        return bs58.encode(this.take(32));
      case "string": {
        const length = this.view(4).getUint32(0, true);
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(length));
      }
      case "u64":
        return this.view(8).getBigUint64(0, true);
      case "i64": {
        const value = this.view(8).getBigInt64(0, true);
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new Error(`${this.event}: i64 ${value.toString()} is outside the safe range`);
        }
        return Number(value);
      }
      case "u16":
        return this.view(2).getUint16(0, true);
      case "bool": {
        const byte = this.view(1).getUint8(0);
        if (byte > 1) throw new Error(`${this.event}: bool byte ${String(byte)}`);
        return byte === 1;
      }
    }
  }

  end(): void {
    if (this.at !== this.data.length) {
      throw new Error(
        `${this.event} payload has ${String(this.data.length - this.at)} trailing bytes`,
      );
    }
  }
}

type Fields = ReadonlyMap<string, FieldValue>;

function field(fields: Fields, name: string): FieldValue {
  if (!fields.has(name)) throw new Error(`event field ${name} is not in the layout`);
  return fields.get(name) ?? null;
}
function str(fields: Fields, name: string): string {
  const v = field(fields, name);
  if (typeof v !== "string") throw new Error(`event field ${name} is not a string`);
  return v;
}
function optStr(fields: Fields, name: string): string | null {
  const v = field(fields, name);
  return v === null ? null : str(fields, name);
}
function u64(fields: Fields, name: string): bigint {
  const v = field(fields, name);
  if (typeof v !== "bigint") throw new Error(`event field ${name} is not a u64`);
  return v;
}
function num(fields: Fields, name: string): number {
  const v = field(fields, name);
  if (typeof v !== "number") throw new Error(`event field ${name} is not a number`);
  return v;
}

function build(name: EscroEventName, f: Fields): EscroEvent {
  const escrow = str(f, "escrow");
  switch (name) {
    case "EscrowCreated":
      return {
        name,
        escrow,
        buyer: str(f, "buyer"),
        taskId: str(f, "task_id"),
        amountUsdc: u64(f, "amount_usdc"),
        feeBps: num(f, "fee_bps"),
        deadline: num(f, "deadline"),
        specHash: str(f, "spec_hash"),
        createdAt: num(f, "created_at"),
        assignedWorker: optStr(f, "assigned_worker"),
      };
    case "TaskClaimed":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        worker: str(f, "worker"),
        claimedAt: num(f, "claimed_at"),
      };
    case "DeliverableSubmitted":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        worker: str(f, "worker"),
        deliverableHash: str(f, "deliverable_hash"),
        proofUri: optStr(f, "proof_uri"),
        submittedAt: num(f, "submitted_at"),
      };
    case "DisputeRaised":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        disputant: str(f, "disputant"),
        reason: str(f, "reason"),
        raisedAt: num(f, "raised_at"),
      };
    case "EscrowCancelled":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        buyer: str(f, "buyer"),
        refundAmount: u64(f, "refund_amount"),
        cancelledAt: num(f, "cancelled_at"),
      };
    case "PaymentReleased":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        worker: str(f, "worker"),
        workerAmount: u64(f, "worker_amount"),
        feeAmount: u64(f, "fee_amount"),
        resolvedAt: num(f, "resolved_at"),
      };
    case "BuyerRefunded":
      return {
        name,
        escrow,
        taskId: str(f, "task_id"),
        buyer: str(f, "buyer"),
        refundAmount: u64(f, "refund_amount"),
        resolvedAt: num(f, "resolved_at"),
      };
  }
}

/**
 * Decode one event payload (the bytes of a `Program data:` line). Null when the discriminator
 * is none of the program's events; a payload that opens with one but does not fill its layout
 * exactly throws.
 */
export function decodeEscroEvent(data: Uint8Array): EscroEvent | null {
  const name = ESCRO_EVENT_NAMES.find((n) =>
    ESCRO_EVENT_LAYOUTS[n].discriminator.every((byte, i) => data[i] === byte),
  );
  if (name === undefined) return null;
  const reader = new Reader(data.subarray(8), name);
  const fields = new Map<string, FieldValue>();
  for (const [fieldName, type] of ESCRO_EVENT_LAYOUTS[name].fields) {
    fields.set(fieldName, reader.read(type));
  }
  reader.end();
  return build(name, fields);
}
