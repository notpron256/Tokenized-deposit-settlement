/**
 * Transaction Evidence view (resumed after the settlement-finality fix):
 * lets an operator click into a past transfer and see the actual backing
 * evidence for its Travel Rule compliance claim — not a summary of what
 * the app says happened, but a fresh read of what's really on-chain,
 * cross-checked live against the current Postgres record.
 *
 * The list (GET /transfers) is sourced from transfer_events, not from
 * on-chain history enumeration (getSignaturesForAddress) — the validator's
 * retained ledger history is short-lived on a local dev environment and
 * was observed mid-session to have already pruned earlier transfers this
 * exact session produced, even though their Postgres rows (and the actual
 * account balances) survived. transfer_events is what makes the list
 * itself restart-proof; the evidence detail below still always reads the
 * transaction fresh from the validator, never from Postgres.
 */
import { Router } from "express";
import bs58 from "bs58";
import { getConnection } from "../solana/authorities.js";
import { pool } from "../db/pool.js";
import { parseTravelRuleMemo, MEMO_PROGRAM_V1, MEMO_PROGRAM_V3 } from "../solana/travelRuleMemo.js";
import { identityHash } from "../solana/identityCommitment.js";

export const transferEvidenceRouter = Router();

transferEvidenceRouter.get("/transfers", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT te.id, te.amount_cents, te.status, te.tx_signature, te.created_at,
              sc.name AS sender_name, rc.name AS recipient_name
       FROM transfer_events te
       JOIN clients sc ON sc.id = te.sender_client_id
       JOIN clients rc ON rc.id = te.recipient_client_id
       ORDER BY te.created_at DESC
       LIMIT 200`,
    );
    res.json(
      rows.map((row) => ({
        id: row.id,
        senderName: row.sender_name,
        recipientName: row.recipient_name,
        amountCents: Number(row.amount_cents),
        status: row.status,
        txSignature: row.tx_signature,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    console.error("Listing transfer evidence failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Pulls the raw Memo instruction's bytes straight out of the transaction's
 * own compiled instructions — not from the program log's Rust-`{:?}`-
 * debug-formatted text, which escapes characters like `"` and `\` and
 * would need un-escaping to recover the exact original bytes. Reading the
 * instruction data directly has no such ambiguity. */
function extractMemoText(tx: NonNullable<Awaited<ReturnType<ReturnType<typeof getConnection>["getTransaction"]>>>): string | null {
  const message = tx.transaction.message as unknown as {
    accountKeys?: { toBase58(): string }[];
    getAccountKeys?: () => { staticAccountKeys: { toBase58(): string }[] };
    compiledInstructions?: { programIdIndex: number; data: Uint8Array }[];
    instructions?: { programIdIndex: number; data: string }[];
  };
  const keys = message.getAccountKeys ? message.getAccountKeys().staticAccountKeys : message.accountKeys ?? [];
  const instructions = message.compiledInstructions ?? message.instructions ?? [];

  for (const ix of instructions) {
    const programId = keys[ix.programIdIndex]?.toBase58();
    if (programId === MEMO_PROGRAM_V1 || programId === MEMO_PROGRAM_V3) {
      const bytes = ix.data instanceof Uint8Array ? ix.data : bs58.decode(ix.data as unknown as string);
      return Buffer.from(bytes).toString("utf-8");
    }
  }
  return null;
}

transferEvidenceRouter.get("/transfers/:signature/evidence", async (req, res) => {
  const { signature } = req.params;
  try {
    const connection = getConnection();
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });

    if (!tx) {
      return res.status(404).json({
        error: `Transaction ${signature} was not found on-chain. On this local validator that almost always means it's aged out of the retained ledger history — a local-dev-only limitation (a real Solana cluster retains this indefinitely), not evidence anything is wrong with the transfer itself.`,
      });
    }
    if (tx.meta?.err) {
      return res.status(422).json({
        error: `Transaction ${signature} is recorded on-chain but failed: ${JSON.stringify(tx.meta.err)}`,
      });
    }

    const memoText = extractMemoText(tx);
    if (!memoText) {
      return res.status(422).json({ error: `Transaction ${signature} has no memo instruction — not a Travel Rule transfer.` });
    }
    const parsed = parseTravelRuleMemo(memoText);
    if (!parsed) {
      return res.status(422).json({
        error: `Transaction ${signature}'s memo is not a well-formed Travel Rule memo: "${memoText}"`,
      });
    }

    async function resolveParty(field: { clientId: string; identityHash: string }) {
      const { rows } = await pool.query(
        `SELECT id, name, registration_id, legal_address FROM clients WHERE id = $1`,
        [field.clientId],
      );
      if (rows.length === 0) {
        return { clientId: field.clientId, onChainHash: field.identityHash, found: false as const };
      }
      const client = rows[0];
      const recomputedHash = identityHash(client);
      return {
        clientId: field.clientId,
        found: true as const,
        name: client.name,
        registrationId: client.registration_id,
        legalAddress: client.legal_address,
        onChainHash: field.identityHash,
        recomputedHash,
        match: recomputedHash === field.identityHash,
      };
    }

    const [ordering, beneficiary] = await Promise.all([
      resolveParty(parsed.ordering),
      resolveParty(parsed.beneficiary),
    ]);

    res.json({
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      memo: { raw: parsed.raw, reference: parsed.reference, remittance: parsed.remittance },
      ordering,
      beneficiary,
    });
  } catch (err) {
    console.error("Building transfer evidence failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
