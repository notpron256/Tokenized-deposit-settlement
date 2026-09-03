/**
 * Reads the on-chain SanctionsRegistry PDA directly, decoding its raw
 * Anchor account bytes (layout: 8 discriminator + 32 sync_authority + 4
 * Vec length prefix + entries * (32 address + 1 source), matching
 * programs/compliance-hook/src/state.rs). Used by the Transfer flow to
 * label a sanctions-check rejection with which entry matched and whether
 * it's real OFAC data or synthetic test data — the same honesty labeling
 * used elsewhere in this project, never inferred, always read from the
 * registry's own `source` field.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { HOOK_PROGRAM_ID } from "./authorities.js";

export const SANCTIONS_SOURCE_LABELS = ["REAL (OFAC SDN)", "SYNTHETIC (TEST)"];

export interface SanctionsEntry {
  address: PublicKey;
  source: number;
}

export function findSanctionsRegistryPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("sanctions-registry")], HOOK_PROGRAM_ID);
  return pda;
}

export async function readSanctionsRegistry(connection: Connection): Promise<SanctionsEntry[]> {
  const pda = findSanctionsRegistryPda();
  const info = await connection.getAccountInfo(pda);
  if (!info) return [];

  const data = info.data;
  const len = data.readUInt32LE(40);
  const entries: SanctionsEntry[] = [];
  let offset = 44;
  for (let i = 0; i < len; i++) {
    entries.push({
      address: new PublicKey(data.subarray(offset, offset + 32)),
      source: data.readUInt8(offset + 32),
    });
    offset += 33;
  }
  return entries;
}
