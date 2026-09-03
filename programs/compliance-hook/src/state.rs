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
