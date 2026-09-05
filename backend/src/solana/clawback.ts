/**
 * Phase 6.5 (plan-001.md): the on-chain half of the Permanent Delegate
 * clawback — a bank-initiated, unilateral compliance-recovery action
 * (spec-001.md, Areas of concern: the SAR/DAML-freeze analogy), distinct
 * from Phase 8's client-initiated, co-signed redemption. Requires the
 * compliance-hook program's Permanent-Delegate exemption (programs/
 * compliance-hook/src/lib.rs's is_permanent_delegate_transfer) to already
 * be deployed — without it, this would still hit the ordinary velocity/
 * Travel-Rule/sanctions checks meant for client-signed transfers.
 *
 * Tokens are TransferChecked (moved), never Burn'd: a bank-controlled
 * recovery ATA holds them intact, reversible, pending whatever more
 * formal legal/investigative determination comes next — matching
 * Permanent Delegate's actual on-chain mechanism and the "protective
 * recovery, not final forfeiture" framing.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createThawAccountInstruction,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { DECIMALS } from "./authorities.js";

const MEMO_PROGRAM_V3 = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Idempotent, self-healing: creates the bank-ops-owned recovery ATA if it
 * doesn't exist yet, and thaws it if it's still frozen (new ATAs are
 * created frozen by default — Default Account State). Not a "client" —
 * deliberately has no row in the `clients` table, since it's bank-owned
 * custody, not a customer account. */
export async function ensureBankRecoveryAta(
  connection: Connection,
  payer: Keypair,
  bankOps: Keypair,
  mint: PublicKey,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    bankOps.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const createIx = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      bankOps.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [payer], {
      commitment: "confirmed",
    });
  }

  const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (account.isFrozen) {
    const thawIx = createThawAccountInstruction(ata, mint, bankOps.publicKey, [], TOKEN_2022_PROGRAM_ID);
    await sendAndConfirmTransaction(connection, new Transaction().add(thawIx), [payer, bankOps], {
      commitment: "confirmed",
    });
  }

  return ata;
}

/** A clean, honestly-labeled, plain-text memo — deliberately NOT forced
 * into the Travel Rule's `:20:/:50K:/:59:/:70:` shape (backend/src/solana/
 * travelRuleMemo.ts): a clawback has no ordering/beneficiary *customer*
 * pair (the recipient is bank-owned custody, not a counterparty), so
 * dressing it up as a Travel Rule transfer would be dishonest labeling of
 * exactly the kind this project avoids elsewhere. This is a real, on-chain
 * audit record in its own right (readable directly in an explorer), not
 * merely a formality — but every consumer inside this app reads the
 * structured `clawback_events` row instead of parsing it back out. */
export function buildClawbackMemo(clientId: string, regulatoryReportReference: string, reason: string): string {
  return `COMPLIANCE CLAWBACK | Reference: ${regulatoryReportReference} | Client: ${clientId} | Reason: ${reason}`;
}

export async function buildClawbackTransaction(
  connection: Connection,
  sourceAta: PublicKey,
  recoveryAta: PublicKey,
  mint: PublicKey,
  bankOps: Keypair,
  amountCents: bigint,
  memoText: string,
): Promise<Transaction> {
  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_V3,
    keys: [],
    data: Buffer.from(memoText, "utf-8"),
  });
  const transferIx = await createTransferCheckedWithTransferHookInstruction(
    connection,
    sourceAta,
    mint,
    recoveryAta,
    bankOps.publicKey,
    amountCents,
    DECIMALS,
    [],
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  return new Transaction().add(memoIx, transferIx);
}
