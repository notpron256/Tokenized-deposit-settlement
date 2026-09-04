/**
 * Phase 5 (plan-001.md): the transfer flow. Moves tokens directly between
 * two onboarded clients' ATAs, subject to the Transfer Hook's four checks
 * (spec-001.md Move/transfer flow) — velocity, Travel Rule memo, sanctions,
 * large-transaction flag. The sender's own custodied key signs (spec-001.md
 * client wallet model); bank-ops is not involved in ordinary transfers.
 *
 * Ledger-first, like Fund's deposit_events: a transfer_events row is
 * written as `pending_chain` before the on-chain transfer is attempted
 * (reversing Phase 5's original "no event table" decision — see
 * spec-001.md's Areas of concern for why). Settlement-finality gating
 * (spec-001.md, Technical approach): the transaction is only ever
 * explicitly confirmed at Solana's "confirmed" commitment first —
 * transfer_events moves to `confirmed`, an intermediate status, not
 * terminal. Only once the transaction separately reaches Solana's
 * "finalized" commitment does the row move to `settled` and
 * ledger_balances actually change on both sides. A `confirmed` row that
 * never reaches `settled` is exactly the kind of anomaly Phase 9
 * reconciliation should surface.
 */
import { Connection, Keypair, PublicKey, SendTransactionError } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferCheckedWithTransferHookInstruction, getAccount } from "@solana/spl-token";
import { Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { pool } from "../db/pool.js";
import { DECIMALS } from "../solana/authorities.js";
import { readSanctionsRegistry, SANCTIONS_SOURCE_LABELS } from "../solana/sanctions.js";
import { identityHash } from "../solana/identityCommitment.js";
import { waitForFinalized } from "../solana/finality.js";

const MEMO_PROGRAM_V3 = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export class TransferError extends Error {
  constructor(message: string, public statusCode: number, public sanctionsBadge?: string) {
    super(message);
  }
}

export interface TransferResult {
  signature: string;
  senderCashBalanceCents: number;
  senderTokenizedCents: number;
  senderOnChainBalanceCents: number;
  recipientCashBalanceCents: number;
  recipientTokenizedCents: number;
  recipientOnChainBalanceCents: number;
}

interface ClientRow {
  id: string;
  name: string;
  ata_address: string;
  owner_address: string;
  status: string;
  registration_id: string;
  legal_address: string;
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const { rows } = await pool.query(
    `SELECT id, name, ata_address, owner_address, status, registration_id, legal_address FROM clients WHERE id = $1`,
    [clientId],
  );
  if (rows.length === 0) {
    throw new TransferError(`No client with id ${clientId}`, 404);
  }
  if (rows[0].status !== "active") {
    // Also excludes a client still sitting at 'confirmed' (onboarded
    // on-chain but not yet finalized) — not just 'suspended'.
    throw new TransferError(`Client "${rows[0].name}" is not active (status: ${rows[0].status})`, 400);
  }
  return rows[0];
}

function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_V3, keys: [], data: Buffer.from(text, "utf-8") });
}

/** Builds a :50K:/:59: party field's content: `<clientId>:<identityHash>`.
 * identityHash (backend/src/solana/identityCommitment.ts) is a SHA-256
 * commitment to this client's identity data *as it exists right now* in
 * Postgres, computed fresh at transfer time (never cached or stored), so
 * it reflects the record at the moment of transfer. Posted on-chain
 * alongside the reference ID so anyone with database access can later
 * recompute this same hash from the current record and compare it against
 * what's immutably on-chain: a match proves the record is unchanged since
 * this transfer; a mismatch proves it was altered afterward. This is a
 * distinct guarantee from the reference ID alone — the ID only proves
 * *linkage* to some record, not that the record's content is what it was
 * at transfer time; the hash is what makes that second claim checkable.
 * `clientId` is a reference pointing at the client's own onboarding record
 * (their Postgres primary key) — never their real legal name, registration
 * ID, or address in cleartext on a public, immutable ledger. That real
 * identifying data still lives in Postgres exactly as captured at
 * onboarding, visible only through the application's own compliance-facing
 * views (e.g. the Onboarding page's client table).
 *
 * This reference-plus-hash design is the industry-standard pattern for
 * crypto Travel Rule compliance (TRISA, Notabene, the Travel Rule Protocol
 * all work this way): identifying data is exchanged off-chain between
 * institutions, never posted on-chain. It only works here because every
 * client shares one database under one institution — see spec-001.md's
 * Areas of concern for why this doesn't generalize to a genuine
 * cross-institution transfer without a real inter-institutional exchange
 * mechanism.
 *
 * A client's id is a Postgres-generated UUID and identityHash's output is
 * always 64 lowercase hex characters — neither is user input, so unlike
 * the free-text reference/remittance fields, there's no possibility of
 * either containing "|" (the memo's own top-level field delimiter). */
function partyField(client: ClientRow): string {
  return `${client.id}:${identityHash(client)}`;
}

/** Maps a rejected transfer's on-chain program logs to a friendly reason.
 * Two distinct layers can reject a missing/malformed memo (spec-001.md
 * Move/transfer flow, check 2): Token-2022's own MemoTransfer account
 * extension rejects outright if *no* memo instruction precedes the
 * transfer at all (a raw SPL Token program error, not one of ours, since
 * it runs before Token-2022 even CPIs into our hook) — only a memo that's
 * *present but malformed* reaches our hook's own structural check
 * (MissingOrInvalidTravelRuleMemo). Matches Anchor's own
 * "Error Code: <Variant>" log line rather than the full #[msg] text, so a
 * wording change in error.rs doesn't silently break this mapping. */
function friendlyRejectionReason(errorCode: string | null, logs: string[], rawMessage: string): string {
  switch (errorCode) {
    case "VelocityLimitExceeded":
      return "Blocked: transfer would exceed the sender's hourly velocity limit.";
    case "MissingOrInvalidTravelRuleMemo":
      return "Blocked: transfer must be immediately preceded by a well-formed Travel Rule memo (present, but malformed).";
    case "SanctionedParty":
      return "Blocked: transfer involves a sanctioned party.";
  }
  if (logs.some((l) => l.includes("No memo in previous instruction"))) {
    return "Blocked: no memo instruction precedes this transfer (Token-2022's Required Memo extension) — a well-formed Travel Rule memo is required immediately before it.";
  }
  return `Blocked: ${rawMessage.split("\n")[0]}`;
}

export async function executeTransfer(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  senderId: string,
  recipientId: string,
  amountCents: number,
  reference: string,
  remittance: string,
): Promise<TransferResult> {
  if (senderId === recipientId) {
    throw new TransferError("Sender and recipient must be different clients", 400);
  }

  const sender = await loadClient(senderId);
  const recipient = await loadClient(recipientId);

  const { rows: keyRows } = await pool.query(`SELECT secret_key FROM client_keys WHERE client_id = $1`, [senderId]);
  if (keyRows.length === 0) {
    throw new TransferError(`No custodied key found for sender "${sender.name}"`, 500);
  }
  const senderKeypair = Keypair.fromSecretKey(Uint8Array.from(keyRows[0].secret_key));

  const sourceAta = new PublicKey(sender.ata_address);
  const destAta = new PublicKey(recipient.ata_address);

  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    sourceAta,
    mint,
    destAta,
    senderKeypair.publicKey,
    BigInt(amountCents),
    DECIMALS,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );

  const tx = new Transaction();
  const reference_ = reference.trim();
  const remittance_ = remittance.trim();
  const ordering = partyField(sender);
  const beneficiary = partyField(recipient);
  if (reference_.length > 0 && remittance_.length > 0) {
    // Only reference/remittance need checking now — ordering/beneficiary
    // are DB-generated client UUIDs (partyField), never user input, so
    // they can't carry a stray "|" (the memo's own top-level delimiter).
    if ([reference_, remittance_].some((s) => s.includes("|"))) {
      throw new TransferError('Transaction reference and remittance information cannot contain "|"', 400);
    }
    tx.add(
      memoInstruction(
        `:20:${reference_}|:50K:${ordering}|:59:${beneficiary}|:70:${remittance_}`,
      ),
    );
  }
  tx.add(transferIx);

  const { rows: eventRows } = await pool.query(
    `INSERT INTO transfer_events (sender_client_id, recipient_client_id, amount_cents, status)
     VALUES ($1, $2, $3, 'pending_chain') RETURNING id`,
    [senderId, recipientId, amountCents],
  );
  const transferEventId: string = eventRows[0].id;

  let signature: string;
  try {
    signature = await sendAndConfirmTransaction(connection, tx, [payer, senderKeypair], { commitment: "confirmed" });
  } catch (err) {
    await pool.query(`UPDATE transfer_events SET status = 'failed' WHERE id = $1`, [transferEventId]);

    const logs = err instanceof SendTransactionError ? err.logs ?? [] : [];
    const joined = logs.join("\n");
    const codeMatch = joined.match(/Error Code: (\w+)/);
    const errorCode = codeMatch?.[1] ?? null;
    const rawMessage = err instanceof Error ? err.message : String(err);

    let sanctionsBadge: string | undefined;
    if (errorCode === "SanctionedParty") {
      const entries = await readSanctionsRegistry(connection);
      const senderOwner = new PublicKey(sender.owner_address);
      const recipientOwner = new PublicKey(recipient.owner_address);
      const hit = entries.find((e) => e.address.equals(senderOwner) || e.address.equals(recipientOwner));
      if (hit) {
        const who = hit.address.equals(senderOwner) ? sender.name : recipient.name;
        sanctionsBadge = `${who} matches a sanctions registry entry — ${SANCTIONS_SOURCE_LABELS[hit.source] ?? "UNKNOWN SOURCE"}`;
      }
    }

    throw new TransferError(friendlyRejectionReason(errorCode, logs, rawMessage), 422, sanctionsBadge);
  }

  // Solana-confirmed, but not yet irreversible — record this intermediate
  // state and the signature now, distinct from the terminal 'settled'
  // state below.
  await pool.query(`UPDATE transfer_events SET status = 'confirmed', tx_signature = $1 WHERE id = $2`, [
    signature,
    transferEventId,
  ]);

  try {
    await waitForFinalized(connection, signature, tx);
  } catch (err) {
    // Row stays at 'confirmed' — the transfer really did happen on-chain,
    // so this isn't 'failed'; it's just not yet provably irreversible.
    // Never update ledger_balances for a transfer that hasn't reached
    // this point.
    throw new TransferError(
      `Transfer confirmed on-chain (tx ${signature}) but did not reach finalized commitment: ${
        err instanceof Error ? err.message : String(err)
      }`,
      503,
    );
  }

  // Safe to read at "confirmed" here — finalization has already happened
  // by this point, so a "confirmed" read reflects the finalized state too.
  const [senderAccount, recipientAccount] = await Promise.all([
    getAccount(connection, sourceAta, "confirmed", TOKEN_2022_PROGRAM_ID),
    getAccount(connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID),
  ]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE transfer_events SET status = 'settled' WHERE id = $1`, [transferEventId]);
    const { rows: senderRows } = await client.query(
      `UPDATE ledger_balances
       SET cash_balance_cents = cash_balance_cents - $1, tokenized_cents = tokenized_cents - $1, updated_at = now()
       WHERE client_id = $2
       RETURNING cash_balance_cents, tokenized_cents`,
      [amountCents, senderId],
    );
    const { rows: recipientRows } = await client.query(
      `UPDATE ledger_balances
       SET cash_balance_cents = cash_balance_cents + $1, tokenized_cents = tokenized_cents + $1, updated_at = now()
       WHERE client_id = $2
       RETURNING cash_balance_cents, tokenized_cents`,
      [amountCents, recipientId],
    );
    await client.query("COMMIT");

    return {
      signature,
      senderCashBalanceCents: Number(senderRows[0].cash_balance_cents),
      senderTokenizedCents: Number(senderRows[0].tokenized_cents),
      senderOnChainBalanceCents: Number(senderAccount.amount),
      recipientCashBalanceCents: Number(recipientRows[0].cash_balance_cents),
      recipientTokenizedCents: Number(recipientRows[0].tokenized_cents),
      recipientOnChainBalanceCents: Number(recipientAccount.amount),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
