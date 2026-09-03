/// Seed for the Transfer Hook interface's extra-account-metas PDA.
/// Mirrors `spl_transfer_hook_interface`'s own (private) seed constant —
/// duplicated here since it isn't exported, but the value is part of the
/// public interface spec and must match exactly for Token-2022 to find the
/// account it expects.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Seed for a client's per-client velocity-tracking PDA, derived as
/// `[VELOCITY_SEED, client_pubkey]`.
pub const VELOCITY_SEED: &[u8] = b"velocity";

/// Fixed-window velocity check duration (spec-001.md: a deliberate POC
/// simplification — a fixed window, not a true sliding window).
pub const VELOCITY_WINDOW_SECONDS: i64 = 3600;

pub const RISK_LOW: u8 = 0;
pub const RISK_MEDIUM: u8 = 1;
pub const RISK_HIGH: u8 = 2;

/// Hourly velocity caps in integer cents (Token design: decimals = 2),
/// matching spec-001.md's Move/transfer flow exactly:
/// low $5,000,000/hr, medium $2,000,000/hr, high $500,000/hr.
pub const CAP_LOW_CENTS: u64 = 500_000_000;
pub const CAP_MEDIUM_CENTS: u64 = 200_000_000;
pub const CAP_HIGH_CENTS: u64 = 50_000_000;

pub fn velocity_cap_for_risk_rating(risk_rating: u8) -> Option<u64> {
    match risk_rating {
        RISK_LOW => Some(CAP_LOW_CENTS),
        RISK_MEDIUM => Some(CAP_MEDIUM_CENTS),
        RISK_HIGH => Some(CAP_HIGH_CENTS),
        _ => None,
    }
}
