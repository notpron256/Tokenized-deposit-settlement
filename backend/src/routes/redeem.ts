import { Router } from "express";
import { getConnection, loadLocalKeypair, requireMintAddress } from "../solana/authorities.js";
import { executeRedeem, RedeemError } from "../flows/redeemFlow.js";

export const redeemRouter = Router();

redeemRouter.post("/redeem", async (req, res) => {
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
    const mint = requireMintAddress();

    const result = await executeRedeem(connection, payer, mint, clientId, amountCents);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof RedeemError) {
      return res.status(err.statusCode).json({ error: err.message, sanctionsBadge: err.sanctionsBadge });
    }
    console.error("Redemption failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
