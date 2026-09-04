/**
 * Phase 4 (plan-001.md): the fund/mint flow. A simulated deposit event
 * (client + amount) books against the client's segregated ledger balance
 * and mints the equivalent tokens to their ATA — spec-001.md's Fund/mint
 * flow, steps 1-3.
 *
 * Ledger-first ordering per plan-001.md decision #5: the deposit_events row
 * is written as `pending_chain` before the on-chain mint is attempted. No
 * saga/compensation logic is implemented, matching that decision.
 *
 * Settlement-finality gating (spec-001.md, Technical approach): the mint
 * transaction is only ever explicitly confirmed at Solana's "confirmed"
 * commitment first — deposit_events moves to `confirmed`, an intermediate
 * status, not terminal. Only once the transaction separately reaches
 * Solana's "finalized" commitment does the row move to `settled` and
 * ledger_balances actually change. A `confirmed` row that never reaches
 * `settled` is exactly the kind of anomaly Phase 9 reconciliation should
 * surface — the ledger must never claim more certainty than the chain has
 * actually reached.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createMintToInstruction, getAccount } from "@solana/spl-token";
import { pool } from "../db/pool.js";
import { waitForFinalized } from "../solana/finality.js";

export class FundError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

export interface FundResult {
  depositEventId: string;
  signature: string;
  cashBalanceCents: number;
  tokenizedCents: number;
  onChainBalanceCents: number;
}

export async function fundClient(
  connection: Connection,
  payer: Keypair,
  bankOps: Keypair,
  mint: PublicKey,
  clientId: string,
  amountCents: number,
): Promise<FundResult> {
  const { rows } = await pool.query(
    `SELECT ata_address, status FROM clients WHERE id = $1`,
    [clientId],
  );
  if (rows.length === 0) {
    // spec-001.md Fund/mint flow step 4: a deposit for a not-yet-onboarded
    // client must fail cleanly, not attempt a mint into a frozen account.
    throw new FundError(`No client with id ${clientId} — has this client been onboarded?`, 404);
  }
  const clientRow = rows[0];
  if (clientRow.status !== "active") {
    // Also excludes a client still sitting at 'confirmed' (onboarded
    // on-chain but not yet finalized) — not just 'suspended'.
    throw new FundError(`Client ${clientId} is not active (status: ${clientRow.status})`, 400);
  }
  const ataAddress = new PublicKey(clientRow.ata_address);

  const { rows: eventRows } = await pool.query(
    `INSERT INTO deposit_events (client_id, amount_cents, status) VALUES ($1, $2, 'pending_chain') RETURNING id`,
    [clientId, amountCents],
  );
  const depositEventId: string = eventRows[0].id;

  let signature: string;
  let tx: Transaction;
  try {
    const mintIx = createMintToInstruction(
      mint,
      ataAddress,
      bankOps.publicKey,
      BigInt(amountCents),
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    tx = new Transaction().add(mintIx);
    signature = await sendAndConfirmTransaction(connection, tx, [payer, bankOps], { commitment: "confirmed" });
  } catch (err) {
    await pool.query(`UPDATE deposit_events SET status = 'failed' WHERE id = $1`, [depositEventId]);
    throw err;
  }

  // Solana-confirmed, but not yet irreversible — record this intermediate
  // state and the signature now, distinct from the terminal 'settled'
  // state below.
  await pool.query(`UPDATE deposit_events SET status = 'confirmed', tx_signature = $1 WHERE id = $2`, [
    signature,
    depositEventId,
  ]);

  try {
    await waitForFinalized(connection, signature, tx);
  } catch (err) {
    // Row stays at 'confirmed' — the mint really did happen on-chain, so
    // this isn't 'failed'; it's just not yet provably irreversible. Never
    // update ledger_balances for a deposit that hasn't reached this point.
    throw new FundError(
      `Deposit confirmed on-chain (tx ${signature}) but did not reach finalized commitment: ${
        err instanceof Error ? err.message : String(err)
      }`,
      503,
    );
  }

  // Safe to read at "confirmed" here — finalization has already happened
  // by this point, so a "confirmed" read reflects the finalized state too.
  const account = await getAccount(connection, ataAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  const onChainBalanceCents = Number(account.amount);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE deposit_events SET status = 'settled' WHERE id = $1`, [depositEventId]);
    const { rows: balanceRows } = await client.query(
      `UPDATE ledger_balances
       SET cash_balance_cents = cash_balance_cents + $1,
           tokenized_cents = tokenized_cents + $1,
           updated_at = now()
       WHERE client_id = $2
       RETURNING cash_balance_cents, tokenized_cents`,
      [amountCents, clientId],
    );
    await client.query("COMMIT");
    return {
      depositEventId,
      signature,
      cashBalanceCents: Number(balanceRows[0].cash_balance_cents),
      tokenizedCents: Number(balanceRows[0].tokenized_cents),
      onChainBalanceCents,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
