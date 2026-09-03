import { Router } from "express";
import { getConnection, loadLocalKeypair, loadOrCreateBankOpsKeypair, requireMintAddress } from "../solana/authorities.js";
import { onboardClientOnChain } from "../solana/onboarding.js";
import { pool } from "../db/pool.js";

export const onboardingRouter = Router();

const RISK_RATINGS = [0, 1, 2] as const;
const RISK_LABELS = ["low", "medium", "high"] as const;

// PREFIX-YYYY-NNNN, e.g. CASE-2026-0417. Keep in sync with the frontend's
// copy of this pattern (frontend/src/pages/Onboarding.tsx). This forces a
// case/ticket-ID *shape*, not real KYC verification — see spec-001.md's
// Areas of concern: the reference itself is never checked against any
// actual system, only checked for looking like a plausible one.
const KYC_REFERENCE_PATTERN = /^[A-Z]+-\d{4}-\d{3,6}$/;

onboardingRouter.post("/clients", async (req, res) => {
  const { name, riskRating, kycReference } = req.body ?? {};

  if (typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ error: "name is required" });
  }
  if (!RISK_RATINGS.includes(riskRating)) {
    return res.status(400).json({ error: "riskRating must be 0 (low), 1 (medium), or 2 (high)" });
  }
  // Not verified against any real KYC/compliance system — see spec-001.md
  // Areas of concern. This is a forcing function and audit-trail entry only;
  // the pattern check only enforces a plausible shape, not a real lookup.
  if (typeof kycReference !== "string" || !KYC_REFERENCE_PATTERN.test(kycReference.trim())) {
    return res.status(400).json({
      error: "kycReference must look like PREFIX-YYYY-NNNN, e.g. CASE-2026-0417",
    });
  }

  try {
    const connection = getConnection();
    const payer = loadLocalKeypair();
    const bankOps = await loadOrCreateBankOpsKeypair(connection);
    const mint = requireMintAddress();

    const result = await onboardClientOnChain(connection, payer, bankOps, mint, riskRating);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO clients (name, risk_rating, ata_address, owner_address, kyc_reference)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, risk_rating, ata_address, owner_address, status, kyc_reference, created_at`,
        [
          name.trim(),
          riskRating,
          result.ataAddress.toBase58(),
          result.client.publicKey.toBase58(),
          kycReference.trim(),
        ],
      );
      const row = rows[0];
      await client.query(
        `INSERT INTO client_keys (client_id, secret_key) VALUES ($1, $2)`,
        [row.id, JSON.stringify(Array.from(result.client.secretKey))],
      );
      await client.query(
        `INSERT INTO ledger_balances (client_id) VALUES ($1)`,
        [row.id],
      );
      await client.query("COMMIT");

      res.status(201).json({
        id: row.id,
        name: row.name,
        riskRating: row.risk_rating,
        riskLabel: RISK_LABELS[row.risk_rating],
        ataAddress: row.ata_address,
        ownerAddress: row.owner_address,
        status: row.status,
        kycReference: row.kyc_reference,
        velocityAccount: result.velocityAccount.toBase58(),
        signature: result.signature,
      });
    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Onboarding failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

onboardingRouter.get("/clients", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.risk_rating, c.ata_address, c.owner_address, c.status, c.kyc_reference, c.created_at,
            lb.cash_balance_cents, lb.tokenized_cents
     FROM clients c
     LEFT JOIN ledger_balances lb ON lb.client_id = c.id
     ORDER BY c.created_at DESC`,
  );
  res.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      riskRating: row.risk_rating,
      riskLabel: RISK_LABELS[row.risk_rating],
      ataAddress: row.ata_address,
      ownerAddress: row.owner_address,
      status: row.status,
      kycReference: row.kyc_reference,
      cashBalanceCents: Number(row.cash_balance_cents ?? 0),
      tokenizedCents: Number(row.tokenized_cents ?? 0),
      createdAt: row.created_at,
    })),
  );
});
