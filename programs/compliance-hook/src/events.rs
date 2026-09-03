use anchor_lang::prelude::*;

/// Non-blocking flag for transfers >= LARGE_TRANSACTION_THRESHOLD_CENTS
/// (spec-001.md Move/transfer flow, check 4) — mirrors real CTR reporting
/// thresholds. The transfer always proceeds; this exists purely as a log
/// record for an off-chain indexer (Phase 6) to pick up and store.
///
/// Deliberately doesn't carry the transaction's own signature: whatever
/// subscribes to this event (e.g. `Connection.onLogs`) already receives the
/// signature as part of that subscription, so embedding it here would be
/// redundant, not more complete.
#[event]
pub struct LargeTransactionFlag {
    pub source_owner: Pubkey,
    pub destination_owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}
