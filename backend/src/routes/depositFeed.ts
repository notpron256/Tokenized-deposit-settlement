/**
 * Phase 4 (plan-001.md): the simulated deposit event feed. spec-001.md's
 * Fund/mint flow and Technical approach both specify a simulated event feed
 * as the sole trigger for minting (no manual entry of ledger/mint state) —
 * this endpoint *is* that simulated feed, triggered on demand from the
 * frontend's "Simulate Deposit" button rather than replayed from a fixture,
 * per plan-001.md's Phase 4 description.
 */
import { Router } from "express";
import { getConnection, loadLocalKeypair, loadOrCreateBankOpsKeypair, requireMintAddress } from "../solana/authorities.js";
import { fundClient, FundError } from "../flows/mintFlow.js";

export const depositFeedRouter = Router();

depositFeedRouter.post("/deposits", async (req, res) => {
  const { clientId, amountCents } = req.body ?? {};

  if (typeof clientId !== "string" || clientId.trim().length === 0) {
    return res.status(400).json({ error: "clientId is required" });
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: "amountCents must be a positive integer" });
  }

  try {
    const connection = getConnection();
    const payer = loadLocalKeypair();
    const bankOps = await loadOrCreateBankOpsKeypair(connection);
    const mint = requireMintAddress();

    const result = await fundClient(connection, payer, bankOps, mint, clientId, amountCents);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof FundError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    console.error("Deposit failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
