use anchor_lang::prelude::*;

/// 8 (discriminator) + 32 (client pubkey) + 1 (risk_rating) + 8 (running_total)
/// + 8 (window_start)
pub const VELOCITY_ACCOUNT_SPACE: usize = 8 + 32 + 1 + 8 + 8;

/// Per-client velocity-tracking account (spec-001.md Token design). Compliance-
/// writable; initialized at onboarding (Phase 3) alongside the Default Account
/// State thaw; read and updated by the Transfer Hook on every transfer.
#[account]
pub struct VelocityAccount {
    pub client: Pubkey,
    pub risk_rating: u8,
    pub running_total: u64,
    pub window_start: i64,
}

/// One sanctions-list entry. `source` is a data-structure fact (not a label
/// applied later off-chain, per plan-001.md Phase 1d) — 0 = real OFAC SDN
/// data, 1 = a synthetic test entry, seeded so the block path is
/// demonstrable even though real Solana-format SDN hits are unlikely.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct SanctionsEntry {
    pub address: Pubkey,
    pub source: u8,
}

/// 32 (address) + 1 (source)
pub const SANCTIONS_ENTRY_SPACE: usize = 32 + 1;

/// Single, global on-chain snapshot of sanctioned Solana addresses
/// (spec-001.md Technical approach). Fully overwritten on each sync — see
/// instructions::update_sanctions_registry — rather than patched
/// incrementally, matching how the real off-chain sync process is
/// specified to work.
#[account]
pub struct SanctionsRegistry {
    pub sync_authority: Pubkey,
    pub entries: Vec<SanctionsEntry>,
}

/// 8 (discriminator) + 32 (sync_authority) + 4 (Vec length prefix) +
/// max_entries * SANCTIONS_ENTRY_SPACE. A fixed cap, not dynamic
/// reallocation — a POC limitation, not a design claim; a real deployment
/// would need to handle the full SDN list's size.
pub fn sanctions_registry_space(max_entries: usize) -> usize {
    8 + 32 + 4 + max_entries * SANCTIONS_ENTRY_SPACE
}
