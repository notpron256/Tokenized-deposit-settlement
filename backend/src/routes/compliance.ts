/**
 * Phase 6's Compliance page backend: independent read views, all sourced
 * from on-chain-derived data rather than the backend's own transfer
 * bookkeeping.
 *
 * - GET /compliance/flags: large-transaction flags only, read from
 *   indexed_transfers (Phase 6's indexer) — never from transfer_events,
 *   so this list reflects what actually reached the chain, not what the
 *   backend's own transfer flow believes happened. Client names are
 *   joined in for display only; indexed_transfers itself has no FK to
 *   clients (spec-001.md's independence design).
 * - GET /compliance/activity: the same source, unfiltered — every settled
 *   transfer the indexer has captured, with the large-transaction flag
 *   included inline rather than requiring a separate lookup. Kept as its
 *   own endpoint (rather than folding /compliance/flags into a client-side
 *   filter of this one) so the flag list stays a minimal, independent
 *   query — this is a superset view added alongside it, not a replacement.
 * - GET /compliance/registry: the on-chain SanctionsRegistry PDA, read
 *   fresh on every request (backend/src/solana/sanctions.ts) — never
 *   cached or mirrored in Postgres — with each entry's `source` field
 *   used to render an honest REAL-vs-SYNTHETIC badge, same labeling
 *   principle used throughout this project (never a hand-maintained UI
 *   list guessing which entries are real).
 */
import { Router } from "express";
import { getConnection, loadOrCreateBankOpsKeypair, networkLabel } from "../solana/authorities.js";
import { readSanctionsRegistry, SANCTIONS_SOURCE_LABELS } from "../solana/sanctions.js";
import { pool } from "../db/pool.js";

export const complianceRouter = Router();

const BANK_RECOVERY_ACCOUNT_LABEL = "Bank Recovery Account (Compliance)";

/** Name resolution for an indexed_transfers row's sender/recipient, in
 * priority order:
 *   1. The Travel Rule memo's ordering/beneficiary client ID, if the memo
 *      was that shape (ordinary client-to-client transfers).
 *   2. The bank-ops recovery ATA's own owner pubkey (Phase 6.5 clawback)
 *      — labeled explicitly rather than left as a raw address, since it
 *      isn't a client and never will be one.
 *   3. A plain owner-address match against `clients` — covers a clawback's
 *      *source* side (a real onboarded client, just not carried in a
 *      Travel-Rule-shaped memo since a clawback has no such pair) and any
 *      other future transfer type that reaches the chain without a
 *      parseable memo.
 * Falls through to `null` (rendered as a raw shortened address) only when
 * none of these resolve — never silently mislabeled. */
function resolveName(
  memoClientName: string | null,
  ownerAddress: string,
  bankRecoveryOwner: string,
  nameByOwner: Map<string, string>,
): string | null {
  if (memoClientName) return memoClientName;
  if (ownerAddress === bankRecoveryOwner) return BANK_RECOVERY_ACCOUNT_LABEL;
  return nameByOwner.get(ownerAddress) ?? null;
}

complianceRouter.get("/compliance/flags", async (_req, res) => {
  try {
    const connection = getConnection();
    const bankOps = await loadOrCreateBankOpsKeypair(connection);
    const bankRecoveryOwner = bankOps.publicKey.toBase58();

    const { rows } = await pool.query(
      `SELECT it.tx_signature, it.block_time, it.amount_cents, it.sender_owner, it.recipient_owner,
              it.ordering_client_id, it.beneficiary_client_id, it.memo_reference,
              oc.name AS ordering_name, bc.name AS beneficiary_name,
              ce.regulatory_report_reference AS clawback_report_reference
       FROM indexed_transfers it
       LEFT JOIN clients oc ON oc.id::text = it.ordering_client_id
       LEFT JOIN clients bc ON bc.id::text = it.beneficiary_client_id
       LEFT JOIN clawback_events ce ON ce.tx_signature = it.tx_signature
       WHERE it.large_transaction_flag = true
       ORDER BY it.block_time DESC NULLS LAST, it.indexed_at DESC
       LIMIT 200`,
    );

    const { rows: clients } = await pool.query(`SELECT name, owner_address FROM clients`);
    const nameByOwner = new Map(clients.map((c) => [c.owner_address, c.name]));

    res.json(
      rows.map((row) => ({
        txSignature: row.tx_signature,
        blockTime: row.block_time,
        amountCents: Number(row.amount_cents),
        senderOwner: row.sender_owner,
        recipientOwner: row.recipient_owner,
        orderingName: resolveName(row.ordering_name, row.sender_owner, bankRecoveryOwner, nameByOwner),
        beneficiaryName: resolveName(row.beneficiary_name, row.recipient_owner, bankRecoveryOwner, nameByOwner),
        // The on-chain Travel Rule memo's :20: field for an ordinary
        // transfer; for a clawback (whose memo isn't Travel-Rule-shaped,
        // so it never carries this) the real regulatory report reference
        // recorded in clawback_events at settlement time instead — never
        // "none" for a legitimate clawback just because its memo takes a
        // different, honestly-labeled shape (spec-001.md, Areas of concern).
        memoReference: row.memo_reference ?? row.clawback_report_reference ?? null,
      })),
    );
  } catch (err) {
    console.error("Listing compliance flags failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

complianceRouter.get("/compliance/activity", async (_req, res) => {
  try {
    const connection = getConnection();
    const bankOps = await loadOrCreateBankOpsKeypair(connection);
    const bankRecoveryOwner = bankOps.publicKey.toBase58();

    const { rows } = await pool.query(
      `SELECT it.tx_signature, it.block_time, it.amount_cents, it.sender_owner, it.recipient_owner,
              it.ordering_client_id, it.beneficiary_client_id, it.memo_reference, it.large_transaction_flag,
              oc.name AS ordering_name, bc.name AS beneficiary_name,
              ce.regulatory_report_reference AS clawback_report_reference
       FROM indexed_transfers it
       LEFT JOIN clients oc ON oc.id::text = it.ordering_client_id
       LEFT JOIN clients bc ON bc.id::text = it.beneficiary_client_id
       LEFT JOIN clawback_events ce ON ce.tx_signature = it.tx_signature
       ORDER BY it.block_time DESC NULLS LAST, it.indexed_at DESC
       LIMIT 500`,
    );

    const { rows: clients } = await pool.query(`SELECT name, owner_address FROM clients`);
    const nameByOwner = new Map(clients.map((c) => [c.owner_address, c.name]));

    res.json(
      rows.map((row) => ({
        txSignature: row.tx_signature,
        blockTime: row.block_time,
        amountCents: Number(row.amount_cents),
        senderOwner: row.sender_owner,
        recipientOwner: row.recipient_owner,
        orderingName: resolveName(row.ordering_name, row.sender_owner, bankRecoveryOwner, nameByOwner),
        beneficiaryName: resolveName(row.beneficiary_name, row.recipient_owner, bankRecoveryOwner, nameByOwner),
        memoReference: row.memo_reference ?? row.clawback_report_reference ?? null,
        largeTransactionFlag: row.large_transaction_flag,
      })),
    );
  } catch (err) {
    console.error("Listing indexed activity failed:", err);
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
