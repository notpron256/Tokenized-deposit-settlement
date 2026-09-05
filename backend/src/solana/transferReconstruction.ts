/**
 * Shared logic for reconstructing a transfer's facts purely from a fetched
 * on-chain transaction — used by both the Transaction Evidence view
 * (backend/src/routes/transferEvidence.ts) and the Phase 6 indexer
 * (backend/scripts/indexer.ts), so the two never drift apart on what
 * counts as "the same reconstruction."
 */
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { MEMO_PROGRAM_V1, MEMO_PROGRAM_V3, parseTravelRuleMemo, type ParsedTravelRuleMemo } from "./travelRuleMemo.js";

export type FetchedTransaction = NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>;

/** Pulls the raw Memo instruction's bytes straight out of the transaction's
 * own compiled instructions — not from the program log's Rust-`{:?}`-
 * debug-formatted text, which escapes characters like `"` and `\` and
 * would need un-escaping to recover the exact original bytes. Reading the
 * instruction data directly has no such ambiguity. */
export function extractMemoText(tx: FetchedTransaction): string | null {
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

/** True only for a transaction that actually performed a Token-2022
 * TransferChecked — not any other instruction that happens to touch the
 * compliance-hook program (onboarding's `init_velocity_account` call,
 * `init_sanctions_registry`/`update_sanctions_registry`, or a program
 * deploy/upgrade all show up in `getSignaturesForAddress(HOOK_PROGRAM_ID)`
 * too, since that call matches *any* transaction referencing the address,
 * not just CPIs into it). Checking for Token-2022's own log line is an
 * unambiguous signal Token-2022 itself emits, independent of our own
 * program's logic. */
export function isTransferTransaction(tx: FetchedTransaction): boolean {
  return (tx.meta?.logMessages ?? []).some((line) => line.includes("Instruction: TransferChecked"));
}

export interface BalanceDelta {
  senderOwner: string;
  recipientOwner: string;
  amountCents: number;
}

/** Derives who sent, who received, and how much — purely from the
 * transaction's own pre/post token balance snapshots, never from Postgres
 * or from decoding the instruction's own amount field. The signs of the
 * deltas alone determine direction; no prior knowledge of which pubkey is
 * "the sender" is needed. */
export function extractBalanceDelta(tx: FetchedTransaction): BalanceDelta | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  if (pre.length === 0 || post.length === 0) return null;

  const preByIndex = new Map(pre.map((b) => [b.accountIndex, b]));
  let senderOwner: string | null = null;
  let recipientOwner: string | null = null;
  let amountCents = 0;

  for (const postBalance of post) {
    const preBalance = preByIndex.get(postBalance.accountIndex);
    if (!preBalance || !postBalance.owner || !preBalance.owner) continue;
    const delta = BigInt(postBalance.uiTokenAmount.amount) - BigInt(preBalance.uiTokenAmount.amount);
    if (delta < 0n) {
      senderOwner = preBalance.owner;
      amountCents = Number(-delta);
    } else if (delta > 0n) {
      recipientOwner = postBalance.owner;
      amountCents = Number(delta);
    }
  }

  if (!senderOwner || !recipientOwner) return null;
  return { senderOwner, recipientOwner, amountCents };
}

export interface LargeTransactionFlagEvent {
  sourceOwner: string;
  destinationOwner: string;
  mint: string;
  amountCents: number;
  timestamp: number;
}

const LARGE_TX_FLAG_DISCRIMINATOR = crypto
  .createHash("sha256")
  .update("event:LargeTransactionFlag")
  .digest()
  .subarray(0, 8);

/** Decodes the `LargeTransactionFlag` event directly from its raw
 * `sol_log_data` bytes (the "Program data: ..." log line Anchor's `emit!`
 * produces) — not from a human-readable log message, and not from any
 * Anchor IDL client. Layout matches programs/compliance-hook/src/events.rs
 * exactly: 8-byte event discriminator, then source_owner/destination_owner/
 * mint (32 bytes each), amount (u64 LE), timestamp (i64 LE). */
export function extractLargeTransactionFlagEvent(tx: FetchedTransaction): LargeTransactionFlagEvent | null {
  for (const line of tx.meta?.logMessages ?? []) {
    const prefix = "Program data: ";
    if (!line.startsWith(prefix)) continue;
    let data: Buffer;
    try {
      data = Buffer.from(line.slice(prefix.length), "base64");
    } catch {
      continue;
    }
    if (data.length !== 120) continue;
    if (!data.subarray(0, 8).equals(LARGE_TX_FLAG_DISCRIMINATOR)) continue;

    return {
      sourceOwner: new PublicKey(data.subarray(8, 40)).toBase58(),
      destinationOwner: new PublicKey(data.subarray(40, 72)).toBase58(),
      mint: new PublicKey(data.subarray(72, 104)).toBase58(),
      amountCents: Number(data.readBigUInt64LE(104)),
      timestamp: Number(data.readBigInt64LE(112)),
    };
  }
  return null;
}

export interface ReconstructedTransfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  senderOwner: string;
  recipientOwner: string;
  amountCents: number;
  memo: ParsedTravelRuleMemo | null;
  largeTransactionFlag: LargeTransactionFlagEvent | null;
}

/** Combines every reconstruction step above. Returns null for any
 * transaction that isn't actually a transfer (onboarding, sanctions
 * registry ops, program deploys — all of which can share a signature
 * history with the hook program without being transfers at all) or that
 * failed on-chain (meta.err set) — a failed-but-broadcast transaction
 * would be a genuine on-chain fact if it ever occurred (see spec-001.md's
 * note on skipPreflight), but this app's preflight-enabled submission
 * means that path is never actually taken in practice; excluded here for
 * safety rather than assumed impossible. */
export function reconstructTransfer(tx: FetchedTransaction, signature: string): ReconstructedTransfer | null {
  if (tx.meta?.err) return null;
  if (!isTransferTransaction(tx)) return null;

  const delta = extractBalanceDelta(tx);
  if (!delta) return null;

  const memoText = extractMemoText(tx);
  const memo = memoText ? parseTravelRuleMemo(memoText) : null;
  const largeTransactionFlag = extractLargeTransactionFlagEvent(tx);

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    senderOwner: delta.senderOwner,
    recipientOwner: delta.recipientOwner,
    amountCents: delta.amountCents,
    memo,
    largeTransactionFlag,
  };
}
