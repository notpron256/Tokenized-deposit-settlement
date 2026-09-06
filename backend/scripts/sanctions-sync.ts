/**
 * Phase 7 (plan-001.md): CLI entry point for the OFAC sanctions sync job.
 *
 * Usage:
 *   tsx scripts/sanctions-sync.ts --dry-run   # fetch + parse + report only, zero blockchain interaction
 *   tsx scripts/sanctions-sync.ts             # dry-run report, then writes to the on-chain registry
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { fetchAndParseOfacSdnList, syncSanctionsRegistry } = await import("../src/jobs/sanctionsSync.js");
const { getConnection, loadLocalKeypair, networkLabel } = await import("../src/solana/authorities.js");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log(`Fetching live OFAC SDN list...`);
  const report = await fetchAndParseOfacSdnList();

  console.log();
  console.log("--- OFAC SDN sync: dry-run report ---");
  console.log(`Source: ${report.sourceUrl}`);
  console.log(`Publish date: ${report.publishDate}`);
  console.log(`Record_Count header: ${report.recordCountFromHeader}`);
  console.log(`Total <sdnEntry> records parsed: ${report.totalSdnEntriesParsed}`);
  console.log(`Entries with at least one digital currency address (any currency): ${report.entriesWithAnyDigitalCurrencyAddress}`);
  console.log(`Total digital currency address entries (any currency): ${report.digitalCurrencyAddressCount}`);
  console.log("Breakdown by currency tag:");
  for (const [tag, count] of Object.entries(report.digitalCurrencyTagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }
  console.log();
  console.log(`Digital Currency Address - SOL entries found: ${report.solanaTaggedCount}`);
  console.log(`Of those, valid Solana-format (new PublicKey(...) succeeds): ${report.solanaValidCount}`);
  if (report.solanaInvalidTagged.length > 0) {
    console.log(`INVALID (tagged SOL but not valid Solana format):`);
    for (const bad of report.solanaInvalidTagged) {
      console.log(`  sdn uid ${bad.sdnUid}: "${bad.address}" -- ${bad.reason}`);
    }
  }
  console.log();
  console.log("Real Solana SDN addresses found:");
  for (const a of report.solanaAddresses) {
    console.log(`  ${a.address}  (SDN entity: ${a.entityName}, uid ${a.sdnUid})`);
  }

  if (dryRun) {
    console.log();
    console.log("Dry run only -- no blockchain interaction. Re-run without --dry-run to write to the registry.");
    return;
  }

  console.log();
  console.log(`Writing to the on-chain registry on network "${networkLabel()}"...`);
  const connection = getConnection();
  const authority = loadLocalKeypair();
  const result = await syncSanctionsRegistry(connection, authority, report);
  console.log(`Registry updated: ${result.realEntriesWritten} real OFAC entry(ies), ${result.syntheticEntriesPreserved} SyntheticTest entry(ies) preserved, ${result.totalEntriesWritten} total.`);
  console.log(`Signature: ${result.signature}`);
}

main().catch((err) => {
  console.error("Sanctions sync failed:", err);
  process.exit(1);
});
