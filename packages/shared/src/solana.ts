// The on-chain address and account-layout entry, apart from the root so a bundle that takes
// only the root never loads web3 for the derivations.
export {
  deriveEscrowPda,
  derivePlatformConfigPda,
  findPlatformConfigPda,
  deriveAdminConfigPda,
  deriveProgramDataPda,
  isCanonicalPubkey,
} from "./pda.js";
export {
  PLATFORM_CONFIG_LAYOUT,
  PLATFORM_CONFIG_DISCRIMINATOR,
  decodePlatformConfig,
} from "./accounts.js";
export type { PlatformConfigAccount } from "./accounts.js";
