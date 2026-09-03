import { Router } from "express";
import { getConnection, loadLocalKeypair, requireMintAddress } from "../solana/authorities.js";
import { executeTransfer, TransferError } from "../flows/transferFlow.js";

export const transferRouter = Router();

transferRouter.post("/transfers", async (req, res) => {
  const { senderId, recipientId, amountCents, reference, remittance } = req.body ?? {};

  if (typeof senderId !== "string" || senderId.trim().length === 0) {
    return res.status(400).json({ error: "senderId is required" });
  }
  if (typeof recipientId !== "string" || recipientId.trim().length === 0) {
    return res.status(400).json({ error: "recipientId is required" });
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: "amountCents must be a positive integer" });
  }

  try {
    const connection = getConnection();
    const payer = loadLocalKeypair();
    const mint = requireMintAddress();

    const result = await executeTransfer(
      connection,
      payer,
      mint,
      senderId,
      recipientId,
      amountCents,
      typeof reference === "string" ? reference : "",
      typeof remittance === "string" ? remittance : "",
    );
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof TransferError) {
      return res.status(err.statusCode).json({ error: err.message, sanctionsBadge: err.sanctionsBadge });
    }
    console.error("Transfer failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
