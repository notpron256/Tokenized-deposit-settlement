/**
 * Phase 6's Compliance page backend: two independent read views, both
 * sourced from on-chain-derived data rather than the backend's own
 * transfer bookkeeping.
 *
 * - GET /compliance/flags: large-transaction flags, read from
 *   indexed_transfers (Phase 6's indexer) — never from transfer_events,
 *   so this list reflects what actually reached the chain, not what the
 *   backend's own transfer flow believes happened. Client names are
 *   joined in for display only; indexed_transfers itself has no FK to
 *   clients (spec-001.md's independence design).
 * - GET /compliance/registry: the on-chain SanctionsRegistry PDA, read
 *   fresh on every request (backend/src/solana/sanctions.ts) — never
 *   cached or mirrored in Postgres — with each entry's `source` field
 *   used to render an honest REAL-vs-SYNTHETIC badge, same labeling
 *   principle used throughout this project (never a hand-maintained UI
 *   list guessing which entries are real).
 */
import { Router } from "express";
import { getConnection, networkLabel } from "../solana/authorities.js";
import { readSanctionsRegistry, SANCTIONS_SOURCE_LABELS } from "../solana/sanctions.js";
import { pool } from "../db/pool.js";

export const complianceRouter = Router();

complianceRouter.get("/compliance/flags", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT it.tx_signature, it.block_time, it.amount_cents, it.sender_owner, it.recipient_owner,
              it.ordering_client_id, it.beneficiary_client_id, it.memo_reference,
              oc.name AS ordering_name, bc.name AS beneficiary_name
       FROM indexed_transfers it
       LEFT JOIN clients oc ON oc.id::text = it.ordering_client_id
       LEFT JOIN clients bc ON bc.id::text = it.beneficiary_client_id
       WHERE it.large_transaction_flag = true
       ORDER BY it.block_time DESC NULLS LAST, it.indexed_at DESC
       LIMIT 200`,
    );
    res.json(
      rows.map((row) => ({
        txSignature: row.tx_signature,
        blockTime: row.block_time,
        amountCents: Number(row.amount_cents),
        senderOwner: row.sender_owner,
        recipientOwner: row.recipient_owner,
        orderingName: row.ordering_name ?? null,
        beneficiaryName: row.beneficiary_name ?? null,
        memoReference: row.memo_reference,
      })),
    );
  } catch (err) {
    console.error("Listing compliance flags failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

complianceRouter.get("/compliance/registry", async (_req, res) => {
  try {
    const connection = getConnection();
    const entries = await readSanctionsRegistry(connection);

    const { rows: clients } = await pool.query(`SELECT name, owner_address FROM clients`);
    const nameByOwner = new Map(clients.map((c) => [c.owner_address, c.name]));

    res.json({
      network: networkLabel(),
      entries: entries.map((entry) => {
        const address = entry.address.toBase58();
        return {
          address,
          source: entry.source,
          sourceLabel: SANCTIONS_SOURCE_LABELS[entry.source] ?? "UNKNOWN SOURCE",
          clientName: nameByOwner.get(address) ?? null,
        };
      }),
    });
  } catch (err) {
    console.error("Reading sanctions registry failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
