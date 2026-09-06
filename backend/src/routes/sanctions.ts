/**
 * Phase 7's admin control: triggers backend/src/jobs/sanctionsSync.ts on
 * demand. Always fetches the live OFAC feed and writes directly — this is
 * the "Sync Now" button's real action, not a dry-run preview (the CLI's
 * `--dry-run` flag is the preview path, for manual review before the
 * first-ever write; this route is for routine re-syncs after that).
 */
import { Router } from "express";
import { getConnection, loadLocalKeypair } from "../solana/authorities.js";
import { fetchAndParseOfacSdnList, syncSanctionsRegistry } from "../jobs/sanctionsSync.js";

export const sanctionsRouter = Router();

sanctionsRouter.post("/sanctions/sync", async (_req, res) => {
  try {
    const report = await fetchAndParseOfacSdnList();

    const connection = getConnection();
    const authority = loadLocalKeypair();
    const result = await syncSanctionsRegistry(connection, authority, report);

    res.json({
      publishDate: report.publishDate,
      totalSdnEntriesParsed: report.totalSdnEntriesParsed,
      solanaTaggedCount: report.solanaTaggedCount,
      solanaValidCount: report.solanaValidCount,
      signature: result.signature,
      realEntriesWritten: result.realEntriesWritten,
      syntheticEntriesPreserved: result.syntheticEntriesPreserved,
      totalEntriesWritten: result.totalEntriesWritten,
    });
  } catch (err) {
    console.error("Sanctions sync failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
