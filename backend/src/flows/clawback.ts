/**
 * Phase 6.5 (plan-001.md): orchestrates a Permanent Delegate clawback —
 * ledger-first (a clawback_events row is written `pending_chain` before
 * anything is submitted, same pattern as deposit_events/transfer_events),
 * with the same confirmed -> finalized -> settled gating (spec-001.md,
 * Technical approach) every other value-moving flow uses. Only
 * `ledger_balances.tokenized_cents` moves on settlement — see
 * schema.sql's clawback_events comment for why cash_balance_cents is
 * deliberately left untouched.
 */
import { Connection, Keypair, PublicKey, SendTransactionError, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { pool } from "../db/pool.js";
import { loadOrCreateBankOpsKeypair } from "../solana/authorities.js";
import { ensureBankRecoveryAta, buildClawbackMemo, buildClawbackTransaction } from "../solana/clawback.js";
import { waitForFinalized } from "../solana/finality.js";

export class ClawbackError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export interface ClawbackResult {
  signature: string;
  amountCents: number;
  clientTokenizedCents: number;
  clientOnChainBalanceCents: number;
}

interface ClientRow {
  id: string;
  name: string;
  ata_address: string;
  status: string;
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const { rows } = await pool.query(`SELECT id, name, ata_address, status FROM clients WHERE id = $1`, [clientId]);
  if (rows.length === 0) {
    throw new ClawbackError(`No client with id ${clientId}`, 404);
  }
  return rows[0];
}

/** amountCents: a specific amount, or "full" to read the client's live
 * on-chain balance at execution time and claw back exactly that — not a
 * UI-displayed, possibly-stale figure, avoiding any race between page
 * load and submission. */
export async function executeClawback(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  clientId: string,
  amountCents: number | "full",
  reason: string,
  regulatoryReportReference: string,
): Promise<ClawbackResult> {
  const reason_ = reason.trim();
  const regRef_ = regulatoryReportReference.trim();
  if (reason_.length === 0) {
    throw new ClawbackError("reason is required", 400);
  }
  if (regRef_.length === 0) {
    throw new ClawbackError("regulatoryReportReference is required", 400);
  }
  if ([reason_, regRef_, clientId].some((s) => s.includes("|"))) {
    throw new ClawbackError('reason and regulatoryReportReference cannot contain "|"', 400);
  }

  const client = await loadClient(clientId);
  const bankOps = await loadOrCreateBankOpsKeypair(connection);
  const sourceAta = new PublicKey(client.ata_address);

  const liveBalance = (await getAccount(connection, sourceAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

  let resolvedAmountCents: bigint;
  if (amountCents === "full") {
    resolvedAmountCents = liveBalance;
  } else {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new ClawbackError("amountCents must be a positive integer, or \"full\"", 400);
    }
    resolvedAmountCents = BigInt(amountCents);
    if (resolvedAmountCents > liveBalance) {
      throw new ClawbackError(
        `Requested ${amountCents} cents exceeds "${client.name}"'s live on-chain balance of ${liveBalance} cents`,
        400,
      );
    }
  }
  if (resolvedAmountCents === 0n) {
    throw new ClawbackError(`"${client.name}" has a zero on-chain balance — nothing to claw back`, 400);
  }

  const recoveryAta = await ensureBankRecoveryAta(connection, payer, bankOps, mint);
  const memoText = buildClawbackMemo(clientId, regRef_, reason_);
  const tx = await buildClawbackTransaction(
    connection,
    sourceAta,
    recoveryAta,
    mint,
    bankOps,
    resolvedAmountCents,
    memoText,
  );

  const { rows: eventRows } = await pool.query(
    `INSERT INTO clawback_events (client_id, amount_cents, reason, regulatory_report_reference, status)
     VALUES ($1, $2, $3, $4, 'pending_chain') RETURNING id`,
    [clientId, resolvedAmountCents.toString(), reason_, regRef_],
  );
  const clawbackEventId: string = eventRows[0].id;

  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [payer, bankOps], { commitment: "confirmed" });
  } catch (err) {
    await pool.query(`UPDATE clawback_events SET status = 'failed' WHERE id = $1`, [clawbackEventId]);
    const logs = err instanceof SendTransactionError ? err.logs ?? [] : [];
    const rawMessage = err instanceof Error ? err.message : String(err);
    throw new ClawbackError(`Clawback failed: ${logs.join("\n") || rawMessage}`, 422);
  }

  await pool.query(`UPDATE clawback_events SET status = 'confirmed', tx_signature = $1 WHERE id = $2`, [
    signature,
    clawbackEventId,
  ]);

  try {
    await waitForFinalized(connection, signature, tx);
  } catch (err) {
    // Row stays at 'confirmed' — the clawback really did happen on-chain,
    // just not yet provably irreversible. Never update ledger_balances
    // before this point.
    throw new ClawbackError(
      `Clawback confirmed on-chain (tx ${signature}) but did not reach finalized commitment: ${
        err instanceof Error ? err.message : String(err)
      }`,
      503,
    );
  }

  const account = await getAccount(connection, sourceAta, "confirmed", TOKEN_2022_PROGRAM_ID);

  const pgClient = await pool.connect();
  try {
    await pgClient.query("BEGIN");
    await pgClient.query(`UPDATE clawback_events SET status = 'settled' WHERE id = $1`, [clawbackEventId]);
    const { rows } = await pgClient.query(
      `UPDATE ledger_balances
       SET tokenized_cents = tokenized_cents - $1, updated_at = now()
       WHERE client_id = $2
       RETURNING tokenized_cents`,
      [resolvedAmountCents.toString(), clientId],
    );
    await pgClient.query("COMMIT");

    return {
      signature,
      amountCents: Number(resolvedAmountCents),
      clientTokenizedCents: Number(rows[0].tokenized_cents),
      clientOnChainBalanceCents: Number(account.amount),
    };
  } catch (err) {
    await pgClient.query("ROLLBACK");
    throw err;
  } finally {
    pgClient.release();
  }
}
