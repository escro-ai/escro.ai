// Program-derived addresses, the one off-chain copy of the program's seeds. Each takes the
// program id, so localnet and ad hoc ids derive the same way as the pinned clusters.
import { PublicKey } from "@solana/web3.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** EscrowAccount: seeds `[b"escrow", buyer, task_id]` (create_escrow.rs); `taskId` is at most 32 bytes. */
export function deriveEscrowPda(programId: PublicKey, buyer: PublicKey, taskId: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8("escrow"), buyer.toBytes(), utf8(taskId)],
    programId,
  )[0];
}

/** PlatformConfig: seeds `[b"config"]`, with the canonical bump the account stores. */
export function findPlatformConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8("config")], programId);
}

export function derivePlatformConfigPda(programId: PublicKey): PublicKey {
  return findPlatformConfigPda(programId)[0];
}

/** AdminConfig: seeds `[b"admin"]`. */
export function deriveAdminConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8("admin")], programId)[0];
}

/**
 * ProgramData: seeds `[program id]` under the upgradeable loader. The loader key is built here, not
 * at module scope: a top-level `PublicKey` would run in every bundle that takes `./solana`.
 */
export function deriveProgramDataPda(programId: PublicKey): PublicKey {
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  return PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0];
}

/** The base-58 of 32 bytes is at most 44 characters (32 bytes of 0xff), so no longer string is a key. */
const MAX_PUBKEY_CHARS = 44;

/**
 * A base58 public key exactly as web3.js prints it, untrimmed: the form wallets compare in. It
 * shares this module's web3 import: in a module of its own, esbuild keeps that module's import
 * in every `./solana` bundle (a bundle of ./solana gains a web3 require it never calls), used or not.
 * The length is checked before the decode, whose cost grows with the square of the length.
 */
export function isCanonicalPubkey(s: string): boolean {
  try {
    // Inside the try: an untyped caller's undefined or null is refused, not thrown.
    if (s.length > MAX_PUBKEY_CHARS) return false;
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}
