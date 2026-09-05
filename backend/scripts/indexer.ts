/**
 * Phase 6 (plan-001.md, scope broadened after Phase 5): the off-chain
 * indexer. A standalone process — not bolted onto server.ts, matching
 * spec-001.md's own "a service" framing — that independently watches the
 * compliance-hook program's on-chain activity and durably logs every
 * transfer that actually reaches the chain, reconstructed purely from
 * on-chain data (backend/src/solana/transferReconstruction.ts). It never
 * reads transfer_events/ledger_balances to decide what happened; those
 * exist so Phase 9 has something to check *against* this table, not a
 * source this table trusts.
 *
 * Runs against whichever network SOLANA_RPC_URL/DATABASE_URL currently
 * point to (backend/src/solana/authorities.ts's networkLabel()) -- same
 * as every other backend component, not two simultaneous per-network
 * instances. To index devnet vs local, run this with the corresponding
 * .env active, same as any other script.
 *
 * Two capture paths, both idempotent (tx_signature is UNIQUE; every write
 * is an upsert):
 *   1. Backfill on startup: getSignaturesForAddress(HOOK_PROGRAM_ID),
 *      paginated backward, catches anything that happened before this
 *      process was running (subject to the target cluster's own retained
 *      ledger history -- short-lived on a local validator, effectively
 *      indefinite on devnet).
 *   2. Live: onLogs(HOOK_PROGRAM_ID) for near-real-time capture of new
 *      activity while this process keeps running.
 *
 * Rejected transfers (velocity/memo/sanctions) never appear here -- they
 * never reach the chain at all under this app's preflight-enabled
 * submission (see spec-001.md's Technical approach for why that's a
 * documented design choice, not a limitation this indexer works around).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PublicKey, type Connection, type ConfirmedSignatureInfo } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { getConnection, HOOK_PROGRAM_ID, networkLabel } = await import("../src/solana/authorities.js");
const { pool } = await import("../src/db/pool.js");
const { reconstructTransfer } = await import("../src/solana/transferReconstruction.js");

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Public devnet RPC rate-limits aggressively (429s) once a backfill fires
// several getTransaction calls back-to-back -- observed empirically: three
// calls in quick succession was enough to exhaust @solana/web3.js's own
// built-in retry/backoff and crash the process outright. A fixed pause
// between each signature keeps backfill under that limit; it costs nothing
// on local (no rate limit there) beyond making backfill slightly slower.
const BACKFILL_THROTTLE_MS = 300;

async function upsertTransfer(signature: string, connection: Connection): Promise<"indexed" | "skipped"> {
  const { rows: existing } = await pool.query(`SELECT 1 FROM indexed_transfers WHERE tx_signature = $1`, [
    signature,
  ]);
  if (existing.length > 0) return "skipped";

  const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) return "skipped";

  const transfer = reconstructTransfer(tx, signature);
  if (!transfer) return "skipped"; // not a real transfer (onboarding, registry ops, deploys, etc.)

  await pool.query(
    `INSERT INTO indexed_transfers (
       tx_signature, slot, block_time, sender_owner, recipient_owner, amount_cents,
       memo_reference, memo_remittance, ordering_client_id, ordering_identity_hash,
       beneficiary_client_id, beneficiary_identity_hash, large_transaction_flag
     ) VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (tx_signature) DO NOTHING`,
    [
      transfer.signature,
      transfer.slot,
      transfer.blockTime,
      transfer.senderOwner,
      transfer.recipientOwner,
      transfer.amountCents,
      transfer.memo?.reference ?? null,
      transfer.memo?.remittance ?? null,
      transfer.memo?.ordering.clientId ?? null,
      transfer.memo?.ordering.identityHash ?? null,
      transfer.memo?.beneficiary.clientId ?? null,
      transfer.memo?.beneficiary.identityHash ?? null,
      transfer.largeTransactionFlag !== null,
    ],
  );

  const flag = transfer.largeTransactionFlag ? " [LARGE TRANSACTION FLAG]" : "";
  console.log(
    `Indexed ${signature.slice(0, 12)}... ${transfer.senderOwner.slice(0, 8)}.. -> ${transfer.recipientOwner.slice(0, 8)}.. ${formatCents(transfer.amountCents)}${flag}`,
  );
  return "indexed";
}

async function backfill(connection: Connection): Promise<void> {
  console.log("Backfilling from on-chain history...");
  let before: string | undefined;
  let totalSeen = 0;
  let totalIndexed = 0;
  const pageLimit = 1000;

  for (;;) {
    const page: ConfirmedSignatureInfo[] = await connection.getSignaturesForAddress(HOOK_PROGRAM_ID, {
      before,
      limit: pageLimit,
    });
    if (page.length === 0) break;

    for (const info of page) {
      totalSeen++;
      try {
        const result = await upsertTransfer(info.signature, connection);
        if (result === "indexed") totalIndexed++;
      } catch (err) {
        console.error(`Failed to index ${info.signature} during backfill (will not be retried this run):`, err);
      }
      await sleep(BACKFILL_THROTTLE_MS);
    }

    before = page[page.length - 1].signature;
    if (page.length < pageLimit) break; // reached the end of retained history
  }

  console.log(`Backfill complete: ${totalSeen} signature(s) touching the hook program examined, ${totalIndexed} real transfer(s) indexed.`);
}

async function watchLive(connection: Connection): Promise<void> {
  console.log(`Watching ${HOOK_PROGRAM_ID.toBase58()} live on "${networkLabel()}" for new transfers...`);
  connection.onLogs(
    HOOK_PROGRAM_ID,
    async (logs) => {
      if (logs.err) return; // never actually reached under this app's preflight-enabled submission
      try {
        await upsertTransfer(logs.signature, connection);
      } catch (err) {
        console.error(`Failed to index ${logs.signature}:`, err);
      }
    },
    "confirmed",
  );
}

async function main() {
  const connection = getConnection();
  console.log(`Indexer starting on network "${networkLabel()}", watching program ${HOOK_PROGRAM_ID.toBase58()}`);

  await backfill(connection);
  await watchLive(connection);

  console.log("Indexer running. Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Indexer failed:", err);
  process.exit(1);
});
