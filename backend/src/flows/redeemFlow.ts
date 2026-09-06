/**
 * Phase 8 (plan-001.md): the redemption flow. Burns tokens directly out
 * of the client's own ATA via the redemption-gateway program (programs/
 * redemption-gateway), never a transfer-to-omnibus convention — see
 * spec-001.md's Redeem/burn flow for the full mechanism and why it
 * replaced the originally assumed Token-2022 `PermissionedBurn`
 * extension (Phase 0.5 finding).
 *
 * Sanctions re-check (spec-001.md step 5): this is the highest-value
 * moment to catch a newly-sanctioned client, since redemption converts
 * token value back into liquid cash. Checked here, directly against the
 * same on-chain SanctionsRegistry PDA the Transfer Hook reads — *before*
 * building any transaction at all. A hit means the backend simply never
 * asks the compliance signer to co-sign; nothing is ever submitted
 * on-chain for a sanctioned client's redemption attempt.
 *
 * Ledger-first, like every other value-moving flow: a redemption_requests
 * row is written `pending_chain` before the on-chain transaction is
 * attempted, then `confirmed` -> `settled` following the same
 * settlement-finality gating as deposit_events/transfer_events
 * (spec-001.md, Technical approach).
 */
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createApproveCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import { Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { pool } from "../db/pool.js";
import { DECIMALS, REDEMPTION_GATEWAY_PROGRAM_ID, loadOrCreateComplianceSignerKeypair } from "../solana/authorities.js";
import { readSanctionsRegistry, SANCTIONS_SOURCE_LABELS } from "../solana/sanctions.js";
import { waitForFinalized } from "../solana/finality.js";

export class RedeemError extends Error {
  constructor(message: string, public statusCode: number, public sanctionsBadge?: string) {
    super(message);
  }
}

export interface RedeemResult {
  signature: string;
  cashBalanceCents: number;
  tokenizedCents: number;
  onChainBalanceCents: number;
}

interface ClientRow {
  id: string;
  name: string;
  ata_address: string;
  owner_address: string;
  status: string;
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const { rows } = await pool.query(
    `SELECT id, name, ata_address, owner_address, status FROM clients WHERE id = $1`,
    [clientId],
  );
  if (rows.length === 0) {
    throw new RedeemError(`No client with id ${clientId}`, 404);
  }
  if (rows[0].status !== "active") {
    throw new RedeemError(`Client "${rows[0].name}" is not active (status: ${rows[0].status})`, 400);
  }
  return rows[0];
}

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
}

const [GATEWAY_AUTHORITY_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("gateway")],
  REDEMPTION_GATEWAY_PROGRAM_ID,
);

export async function executeRedeem(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  clientId: string,
  amountCents: number,
): Promise<RedeemResult> {
  const client = await loadClient(clientId);

  // --- Sanctions re-check, before anything else is even attempted ---
  const entries = await readSanctionsRegistry(connection);
  const clientOwner = new PublicKey(client.owner_address);
  const hit = entries.find((e) => e.address.equals(clientOwner));
  if (hit) {
    await pool.query(
      `INSERT INTO redemption_requests (client_id, amount_cents, status) VALUES ($1, $2, 'refused_sanctioned')`,
      [clientId, amountCents],
    );
    const badge = `${client.name} matches a sanctions registry entry — ${SANCTIONS_SOURCE_LABELS[hit.source] ?? "UNKNOWN SOURCE"}`;
    throw new RedeemError(
      `Blocked: "${client.name}" matches a sanctions registry entry. Redemption refused before any burn was attempted — the compliance signer will not co-sign.`,
      422,
      badge,
    );
  }

  const clientKeypairRow = await pool.query(`SELECT secret_key FROM client_keys WHERE client_id = $1`, [clientId]);
  if (clientKeypairRow.rows.length === 0) {
    throw new RedeemError(`No custodied key found for "${client.name}"`, 500);
  }
  const clientKeypair = Keypair.fromSecretKey(Uint8Array.from(clientKeypairRow.rows[0].secret_key));
  const complianceSigner = loadOrCreateComplianceSignerKeypair();

  const ata = new PublicKey(client.ata_address);

  const approveIx = createApproveCheckedInstruction(
    ata,
    mint,
    GATEWAY_AUTHORITY_PDA,
    clientKeypair.publicKey,
    BigInt(amountCents),
    DECIMALS,
    [],
    TOKEN_2022_PROGRAM_ID,
  );

  const redeemIx = new TransactionInstruction({
    programId: REDEMPTION_GATEWAY_PROGRAM_ID,
    keys: [
      { pubkey: clientKeypair.publicKey, isSigner: true, isWritable: false },
      { pubkey: complianceSigner.publicKey, isSigner: true, isWritable: false },
      { pubkey: GATEWAY_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("redeem"),
      (() => {
        const buf = Buffer.alloc(9);
        buf.writeBigUInt64LE(BigInt(amountCents), 0);
        buf.writeUInt8(DECIMALS, 8);
        return buf;
      })(),
    ]),
  });

  const tx = new Transaction().add(approveIx, redeemIx);

  const { rows: eventRows } = await pool.query(
    `INSERT INTO redemption_requests (client_id, amount_cents, status) VALUES ($1, $2, 'pending_chain') RETURNING id`,
    [clientId, amountCents],
  );
  const redemptionRequestId: string = eventRows[0].id;

  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [payer, clientKeypair, complianceSigner], {
      commitment: "confirmed",
    });
  } catch (err) {
    await pool.query(`UPDATE redemption_requests SET status = 'failed' WHERE id = $1`, [redemptionRequestId]);
    const logs = err instanceof SendTransactionError ? err.logs ?? [] : [];
    const rawMessage = err instanceof Error ? err.message : String(err);
    throw new RedeemError(`Redemption failed: ${logs.join("\n") || rawMessage}`, 422);
  }

  await pool.query(`UPDATE redemption_requests SET status = 'confirmed', tx_signature = $1 WHERE id = $2`, [
    signature,
    redemptionRequestId,
  ]);

  try {
    await waitForFinalized(connection, signature, tx);
  } catch (err) {
    // The burn really did happen on-chain -- stays 'confirmed', not
    // 'failed', and never touches the ledger until finality is proven.
    throw new RedeemError(
      `Redemption confirmed on-chain (tx ${signature}) but did not reach finalized commitment: ${
        err instanceof Error ? err.message : String(err)
      }`,
      503,
    );
  }

  const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);

  const pgClient = await pool.connect();
  try {
    await pgClient.query("BEGIN");
    await pgClient.query(`UPDATE redemption_requests SET status = 'settled' WHERE id = $1`, [redemptionRequestId]);
    // Redemption follows the clawback pattern, not the mint pattern (see
    // spec-001.md's Redeem/burn flow step 8 and Areas of concern): it
    // converts the token back into an ordinary, non-tokenized deposit --
    // the client's money stays at the bank, it isn't a withdrawal.
    // cash_balance_cents already represents the client's TOTAL deposit
    // liability regardless of tokenized status (this is exactly what
    // Fund/mint's "both increase together" means: a new deposit increases
    // total liability and simultaneously tokenizes all of it). Redemption
    // is the inverse of *that specific action* -- un-tokenizing, not
    // extinguishing the liability -- so only tokenized_cents decreases;
    // cash_balance_cents is deliberately left untouched, exactly like a
    // clawback.
    const { rows } = await pgClient.query(
      `UPDATE ledger_balances
       SET tokenized_cents = tokenized_cents - $1, updated_at = now()
       WHERE client_id = $2
       RETURNING cash_balance_cents, tokenized_cents`,
      [amountCents, clientId],
    );
    await pgClient.query("COMMIT");

    return {
      signature,
      cashBalanceCents: Number(rows[0].cash_balance_cents),
      tokenizedCents: Number(rows[0].tokenized_cents),
      onChainBalanceCents: Number(account.amount),
    };
  } catch (err) {
    await pgClient.query("ROLLBACK");
    throw err;
  } finally {
    pgClient.release();
  }
}
