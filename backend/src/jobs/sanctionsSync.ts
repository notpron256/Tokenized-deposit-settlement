/**
 * Phase 7 (plan-001.md): the real OFAC SDN sanctions sync job.
 *
 * Fetches the live SDN list from OFAC's own Sanctions List Service (the
 * modern replacement for the legacy treasury.gov download paths, which
 * now 302-redirect here), extracts every "Digital Currency Address - SOL"
 * entry -- the only OFAC currency tag whose address format matches what
 * this app's SanctionsRegistry stores -- and validates each one is a
 * genuine Solana public key (`new PublicKey(...)` succeeding: correct
 * base58, exactly 32 bytes) rather than trusting OFAC's own currency-type
 * label at face value. OFAC also tags Bitcoin/Ethereum/Tron/etc.
 * addresses, which are structurally incompatible with a Solana pubkey and
 * are correctly never even attempted here.
 *
 * The registry write is a full replace (see update_sanctions_registry's
 * own doc comment), so every sync preserves whatever SyntheticTest
 * entries are already on-chain (Phase 0.5/2's seeded test address) rather
 * than overwriting them -- real and synthetic entries are merged, never
 * one replacing the other.
 */
import { XMLParser } from "fast-xml-parser";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { HOOK_PROGRAM_ID } from "../solana/authorities.js";
import { readSanctionsRegistry, SanctionsEntry } from "../solana/sanctions.js";

export const OFAC_SDN_XML_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";

const SANCTIONS_SOURCE_OFAC_SDN = 0;
const SANCTIONS_SOURCE_SYNTHETIC_TEST = 1;

export interface SolanaSdnAddress {
  sdnUid: number;
  entityName: string;
  address: string;
}

export interface OfacSyncReport {
  sourceUrl: string;
  publishDate: string;
  recordCountFromHeader: number;
  totalSdnEntriesParsed: number;
  entriesWithAnyDigitalCurrencyAddress: number;
  digitalCurrencyAddressCount: number;
  digitalCurrencyTagCounts: Record<string, number>;
  solanaTaggedCount: number;
  solanaValidCount: number;
  solanaInvalidTagged: { sdnUid: number; address: string; reason: string }[];
  solanaAddresses: SolanaSdnAddress[];
}

export async function fetchOfacSdnXml(): Promise<string> {
  const res = await fetch(OFAC_SDN_XML_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch OFAC SDN list from ${OFAC_SDN_XML_URL}: HTTP ${res.status}`);
  }
  return res.text();
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function parseOfacSdnList(xml: string): OfacSyncReport {
  const parser = new XMLParser({ ignoreAttributes: true });
  const doc = parser.parse(xml);
  const list = doc.sdnList;
  if (!list) {
    throw new Error("Parsed XML has no <sdnList> root element -- OFAC may have changed the feed's format");
  }

  const publishDate = String(list.publshInformation?.Publish_Date ?? "unknown");
  const recordCountFromHeader = Number(list.publshInformation?.Record_Count ?? 0);

  const entries = asArray(list.sdnEntry);

  let entriesWithAnyDigitalCurrencyAddress = 0;
  let digitalCurrencyAddressCount = 0;
  const digitalCurrencyTagCounts: Record<string, number> = {};
  let solanaTaggedCount = 0;
  const solanaAddresses: SolanaSdnAddress[] = [];
  const solanaInvalidTagged: { sdnUid: number; address: string; reason: string }[] = [];

  for (const entry of entries) {
    const ids = asArray(entry.idList?.id);
    let hasAnyDigitalCurrency = false;

    for (const id of ids) {
      const idType = String(id.idType ?? "");
      if (!idType.startsWith("Digital Currency Address")) continue;

      hasAnyDigitalCurrency = true;
      digitalCurrencyAddressCount++;
      const tag = idType.replace("Digital Currency Address - ", "");
      digitalCurrencyTagCounts[tag] = (digitalCurrencyTagCounts[tag] ?? 0) + 1;

      if (idType !== "Digital Currency Address - SOL") continue;

      solanaTaggedCount++;
      const address = String(id.idNumber ?? "").trim();
      const sdnUid = Number(entry.uid);
      try {
        new PublicKey(address); // throws unless valid base58, exactly 32 bytes -- never trust OFAC's own tag alone
        solanaAddresses.push({
          sdnUid,
          entityName: String(entry.lastName ?? entry.firstName ?? `uid ${sdnUid}`),
          address,
        });
      } catch (err) {
        solanaInvalidTagged.push({ sdnUid, address, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (hasAnyDigitalCurrency) entriesWithAnyDigitalCurrencyAddress++;
  }

  return {
    sourceUrl: OFAC_SDN_XML_URL,
    publishDate,
    recordCountFromHeader,
    totalSdnEntriesParsed: entries.length,
    entriesWithAnyDigitalCurrencyAddress,
    digitalCurrencyAddressCount,
    digitalCurrencyTagCounts,
    solanaTaggedCount,
    solanaValidCount: solanaAddresses.length,
    solanaInvalidTagged,
    solanaAddresses,
  };
}

export async function fetchAndParseOfacSdnList(): Promise<OfacSyncReport> {
  return parseOfacSdnList(await fetchOfacSdnXml());
}

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
}

function encodeEntries(entries: { address: PublicKey; source: number }[]): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(entries.length);
  const entryBufs = entries.map((e) => Buffer.concat([e.address.toBuffer(), Buffer.from([e.source])]));
  return Buffer.concat([lenBuf, ...entryBufs]);
}

export interface SyncResult {
  signature: string;
  realEntriesWritten: number;
  syntheticEntriesPreserved: number;
  totalEntriesWritten: number;
}

/** Writes the parsed real OFAC entries to the on-chain registry, always
 * reading the CURRENT registry first and carrying its SyntheticTest
 * entries forward -- a sync never overwrites or relabels them, since
 * update_sanctions_registry is a full replace, not incremental. */
export async function syncSanctionsRegistry(
  connection: Connection,
  authority: Keypair,
  report: OfacSyncReport,
): Promise<SyncResult> {
  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("sanctions-registry")], HOOK_PROGRAM_ID);

  const existing = await readSanctionsRegistry(connection);
  const syntheticEntries = existing.filter((e) => e.source === SANCTIONS_SOURCE_SYNTHETIC_TEST);

  const realEntries: SanctionsEntry[] = report.solanaAddresses.map((a) => ({
    address: new PublicKey(a.address),
    source: SANCTIONS_SOURCE_OFAC_SDN,
  }));

  const newEntries = [...realEntries, ...syntheticEntries];

  const updateIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([anchorDiscriminator("update_sanctions_registry"), encodeEntries(newEntries)]),
  });

  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(updateIx), [authority], {
    commitment: "confirmed",
  });

  return {
    signature,
    realEntriesWritten: realEntries.length,
    syntheticEntriesPreserved: syntheticEntries.length,
    totalEntriesWritten: newEntries.length,
  };
}
