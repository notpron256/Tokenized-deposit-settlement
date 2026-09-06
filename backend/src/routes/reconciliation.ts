import { Router } from "express";
import { getConnection, requireMintAddress } from "../solana/authorities.js";
import { runReconciliation } from "../jobs/reconciliation.js";
import { pool } from "../db/pool.js";

export const reconciliationRouter = Router();

reconciliationRouter.post("/reconciliation/run", async (_req, res) => {
  try {
    const connection = getConnection();
    const mint = requireMintAddress();
    const result = await runReconciliation(connection, mint);
    res.json(result);
  } catch (err) {
    console.error("Reconciliation run failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

reconciliationRouter.get("/reconciliation/breaks", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT rb.id, rb.client_id, c.name AS client_name, rb.break_type, rb.classification,
              rb.expected_cents, rb.actual_cents, rb.delta_cents, rb.note, rb.created_at
       FROM reconciliation_breaks rb
       LEFT JOIN clients c ON c.id = rb.client_id
       ORDER BY rb.created_at DESC
       LIMIT 200`,
    );
    res.json(
      rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        clientName: row.client_name,
        breakType: row.break_type,
        classification: row.classification,
        expectedCents: Number(row.expected_cents),
        actualCents: Number(row.actual_cents),
        deltaCents: Number(row.delta_cents),
        note: row.note,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    console.error("Listing reconciliation breaks failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
