import { Router } from "express";
import { getConnection, loadLocalKeypair, loadOrCreateBankOpsKeypair, requireMintAddress } from "../solana/authorities.js";
import { onboardClientOnChain } from "../solana/onboarding.js";
import { waitForFinalized } from "../solana/finality.js";
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
  const { name, riskRating, kycReference, registrationId, legalAddress } = req.body ?? {};

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
  // Real identifying data, resolved by reference at transfer time into the
  // Travel Rule memo's :50K:/:59: fields (spec-001.md Move/transfer flow) —
  // never posted on-chain in cleartext itself. Not verified against any
  // real registry, same honesty posture as kycReference above.
  if (typeof registrationId !== "string" || registrationId.trim().length === 0) {
    return res.status(400).json({ error: "registrationId is required" });
  }
  if (typeof legalAddress !== "string" || legalAddress.trim().length === 0) {
    return res.status(400).json({ error: "legalAddress is required" });
  }

  try {
    const connection = getConnection();
    const payer = loadLocalKeypair();
    const bankOps = await loadOrCreateBankOpsKeypair(connection);
    const mint = requireMintAddress();

    const result = await onboardClientOnChain(connection, payer, bankOps, mint, riskRating);

    // Settlement-finality gating (spec-001.md, Technical approach): the
    // onboarding transaction is only Solana-"confirmed" at this point, not
    // yet finalized. A client only becomes 'active' — the status every
    // other flow trusts to mean "this client may transact" — once that
    // separately resolves. If it doesn't, the row is still created (so a
    // real on-chain onboarding is never silently lost) but stays at
    // 'confirmed', which Fund/Transfer both already treat as not usable.
    let clientStatus: "active" | "confirmed" = "confirmed";
    let finalizeError: string | undefined;
    try {
      await waitForFinalized(connection, result.signature, result.tx);
      clientStatus = "active";
    } catch (err) {
      finalizeError = err instanceof Error ? err.message : String(err);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO clients (name, risk_rating, ata_address, owner_address, status, kyc_reference, registration_id, legal_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, risk_rating, ata_address, owner_address, status, kyc_reference, registration_id, legal_address, created_at`,
        [
          name.trim(),
          riskRating,
          result.ataAddress.toBase58(),
          result.client.publicKey.toBase58(),
          clientStatus,
          kycReference.trim(),
          registrationId.trim(),
          legalAddress.trim(),
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

      const body = {
        id: row.id,
        name: row.name,
        riskRating: row.risk_rating,
        riskLabel: RISK_LABELS[row.risk_rating],
        ataAddress: row.ata_address,
        ownerAddress: row.owner_address,
        status: row.status,
        kycReference: row.kyc_reference,
        registrationId: row.registration_id,
        legalAddress: row.legal_address,
        velocityAccount: result.velocityAccount.toBase58(),
        signature: result.signature,
      };

      if (clientStatus === "active") {
        res.status(201).json(body);
      } else {
        // 202, not an error status: the client genuinely was created and
        // onboarded on-chain — it just isn't finalized yet, so the
        // response carries the full body (unlike a thrown error, which
        // would lose it) plus a `warning` the frontend renders distinctly.
        res.status(202).json({
          ...body,
          warning: `Onboarded on-chain (tx ${result.signature}) but did not reach finalized commitment before responding: ${finalizeError}. Client created with status 'confirmed', not yet 'active' — Fund/Transfer will refuse it until finalization completes.`,
        });
      }
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
    `SELECT c.id, c.name, c.risk_rating, c.ata_address, c.owner_address, c.status, c.kyc_reference,
            c.registration_id, c.legal_address, c.created_at,
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
      registrationId: row.registration_id,
      legalAddress: row.legal_address,
      cashBalanceCents: Number(row.cash_balance_cents ?? 0),
      tokenizedCents: Number(row.tokenized_cents ?? 0),
      createdAt: row.created_at,
    })),
  );
});
