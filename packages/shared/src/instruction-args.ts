import bs58 from "bs58";
import { ESCROW_INSTRUCTIONS } from "./instructions.js";

// The decoders invert the encoders: the SDK checks a server-built instruction through them
// before signing.

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function borshU64(n: bigint): Buffer {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

function borshI64(n: bigint): Buffer {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigInt64LE(n, 0);
  return buf;
}

function borshOption(payload: Buffer | null): Buffer {
  if (payload === null) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), payload]);
}

function disc(name: "create_escrow" | "submit_deliverable" | "raise_dispute"): Buffer {
  return Buffer.from(ESCROW_INSTRUCTIONS[name].discriminator);
}

export interface CreateEscrowArgs {
  taskId: string;
  amount: bigint;
  deadline: bigint;
  specHash: string;
  /** base58 on decode; raw 32 bytes on encode. */
  assignedWorker: string | null;
}

export function encodeCreateEscrowArgs(
  args: Omit<CreateEscrowArgs, "assignedWorker"> & { assignedWorker: Uint8Array | null },
): Buffer {
  return Buffer.concat([
    disc("create_escrow"),
    borshString(args.taskId),
    borshU64(args.amount),
    borshI64(args.deadline),
    borshString(args.specHash),
    borshOption(args.assignedWorker === null ? null : Buffer.from(args.assignedWorker)),
  ]);
}

export function encodeSubmitDeliverableArgs(args: {
  deliverableHash: string;
  proofUri: string | null;
}): Buffer {
  return Buffer.concat([
    disc("submit_deliverable"),
    borshString(args.deliverableHash),
    borshOption(args.proofUri === null ? null : borshString(args.proofUri)),
  ]);
}

export function encodeRaiseDisputeArgs(reason: string): Buffer {
  return Buffer.concat([disc("raise_dispute"), borshString(reason)]);
}

/** Sequential Borsh reader over instruction data, past the 8-byte discriminator. */
class Reader {
  private offset = 8;
  constructor(private readonly buf: Buffer) {}

  private take(n: number): Buffer {
    if (this.offset + n > this.buf.length) {
      throw new Error(
        `instruction data truncated: need ${String(n)} bytes at offset ${String(this.offset)}, have ${String(this.buf.length)}`,
      );
    }
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.take(1).readUInt8(0);
  }
  u64(): bigint {
    return this.take(8).readBigUInt64LE(0);
  }
  i64(): bigint {
    return this.take(8).readBigInt64LE(0);
  }
  string(): string {
    const len = this.take(4).readUInt32LE(0);
    return this.take(len).toString("utf8");
  }
  option<T>(read: () => T): T | null {
    return this.u8() === 0 ? null : read();
  }
  bytes(n: number): Buffer {
    return this.take(n);
  }
}

export function decodeCreateEscrowArgs(data: Uint8Array): CreateEscrowArgs {
  const r = new Reader(Buffer.from(data));
  return {
    taskId: r.string(),
    amount: r.u64(),
    deadline: r.i64(),
    specHash: r.string(),
    assignedWorker: r.option(() => bs58.encode(r.bytes(32))),
  };
}

export function decodeSubmitDeliverableArgs(data: Uint8Array): {
  deliverableHash: string;
  proofUri: string | null;
} {
  const r = new Reader(Buffer.from(data));
  return { deliverableHash: r.string(), proofUri: r.option(() => r.string()) };
}

export function decodeRaiseDisputeArgs(data: Uint8Array): { reason: string } {
  return { reason: new Reader(Buffer.from(data)).string() };
}

/** `amount_usdc` is numeric whole-USDC; the chain carries u64 micro-USDC. */
export function microToUsdcString(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}
