/**
 * Phase 4 (plan-001.md): the fund/mint flow. A simulated deposit event
 * (client + amount) books against the client's segregated ledger balance
 * and mints the equivalent tokens to their ATA — spec-001.md's Fund/mint
 * flow, steps 1-3.
 *
 * Ledger-first ordering per plan-001.md decision #5: the deposit_events row
 * is written as `pending_chain` before the on-chain mint is attempted, then
 * flipped to `confirmed` (with the tx signature) or `failed` afterward. This
 * is intentionally not atomic with the on-chain step — a crash between the
 * mint succeeding on-chain and this process recording that fact leaves a
 * `pending_chain` row that only reconciliation (Phase 9) would catch. No
 * saga/compensation logic is implemented, matching that decision.
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
    throw new FundError(`Client ${clientId} is not active (status: ${clientRow.status})`, 400);
  }
  const ataAddress = new PublicKey(clientRow.ata_address);

  const { rows: eventRows } = await pool.query(
    `INSERT INTO deposit_events (client_id, amount_cents, status) VALUES ($1, $2, 'pending_chain') RETURNING id`,
    [clientId, amountCents],
  );
  const depositEventId: string = eventRows[0].id;

  let signature: string;
  let onChainBalanceCents: number;
  try {
    const mintIx = createMintToInstruction(
      mint,
      ataAddress,
      bankOps.publicKey,
      BigInt(amountCents),
      [],
      TOKEN_2022_PROGRAM_ID,
    );
    signature = await sendAndConfirmTransaction(connection, new Transaction().add(mintIx), [payer, bankOps]);

    // Read the ATA back directly rather than trusting our own arithmetic —
    // this is what lets the UI show the on-chain balance actually matches.
    const account = await getAccount(connection, ataAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
    onChainBalanceCents = Number(account.amount);
  } catch (err) {
    await pool.query(`UPDATE deposit_events SET status = 'failed' WHERE id = $1`, [depositEventId]);
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deposit_events SET status = 'confirmed', tx_signature = $1 WHERE id = $2`,
      [signature, depositEventId],
    );
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
