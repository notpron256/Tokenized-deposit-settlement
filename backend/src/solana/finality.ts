/**
 * Waits for a transaction to reach Solana's own "finalized" commitment
 * level, distinct from "confirmed" — see spec-001.md's Technical approach
 * for why the two are kept conceptually separate. "Confirmed" means a
 * supermajority of the cluster has voted for the block containing this
 * transaction, but that block could in principle still be dropped in a
 * fork before it's finalized; only "finalized" means the transaction is
 * actually irreversible. A ledger row is only allowed to claim the
 * business-level "settled" status (as opposed to the intermediate
 * "confirmed" status) once this resolves successfully.
 *
 * Reuses the exact blockhash/lastValidBlockHeight that sending the
 * transaction already populated onto `tx` — Connection.sendTransaction
 * mutates the Transaction object it's given, setting both fields before
 * signing — so this re-runs the same block-height-exceedance confirmation
 * strategy @solana/web3.js's own sendAndConfirmTransaction uses
 * internally, just at "finalized" instead of whatever commitment the
 * initial send/confirm targeted.
 */
import { Connection, Transaction } from "@solana/web3.js";

export async function waitForFinalized(connection: Connection, signature: string, tx: Transaction): Promise<void> {
  if (!tx.recentBlockhash || tx.lastValidBlockHeight === undefined) {
    throw new Error(
      "Transaction is missing recentBlockhash/lastValidBlockHeight — cannot wait for finalized commitment",
    );
  }
  const result = await connection.confirmTransaction(
    { signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight },
    "finalized",
  );
  if (result.value.err) {
    throw new Error(`Transaction ${signature} did not finalize successfully: ${JSON.stringify(result.value.err)}`);
  }
}
