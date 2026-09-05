import { Router } from "express";
import { getConnection, loadLocalKeypair, requireMintAddress } from "../solana/authorities.js";
import { executeClawback, ClawbackError } from "../flows/clawback.js";
import { pool } from "../db/pool.js";

export const clawbackRouter = Router();

clawbackRouter.post("/clawback", async (req, res) => {
  const { clientId, amountCents, reason, regulatoryReportReference } = req.body ?? {};

  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    return res.status(400).json({ error: "clientId is required" });
  }
  const amount: number | "full" = amountCents === "full" ? "full" : Number(amountCents);
  if (amount !== "full" && (!Number.isInteger(amount) || amount <= 0)) {
    return res.status(400).json({ error: 'amountCents must be a positive integer, or "full"' });
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return res.status(400).json({ error: "reason is required" });
  }
  if (typeof regulatoryReportReference !== "string" || regulatoryReportReference.trim().length === 0) {
    return res.status(400).json({ error: "regulatoryReportReference is required" });
  }

  try {
    const connection = getConnection();
    const payer = loadLocalKeypair();
    const mint = requireMintAddress();

    const result = await executeClawback(connection, payer, mint, clientId, amount, reason, regulatoryReportReference);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ClawbackError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Clawback failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

clawbackRouter.get("/clawback", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ce.id, ce.amount_cents, ce.reason, ce.regulatory_report_reference, ce.status, ce.tx_signature, ce.created_at,
              c.name AS client_name
       FROM clawback_events ce
       JOIN clients c ON c.id = ce.client_id
       ORDER BY ce.created_at DESC
       LIMIT 200`,
    );
    res.json(
      rows.map((row) => ({
        id: row.id,
        clientName: row.client_name,
        amountCents: Number(row.amount_cents),
        reason: row.reason,
        regulatoryReportReference: row.regulatory_report_reference,
        status: row.status,
        txSignature: row.tx_signature,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    console.error("Listing clawback events failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
