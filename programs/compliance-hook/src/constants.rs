/// Seed for the Transfer Hook interface's extra-account-metas PDA.
/// Mirrors `spl_transfer_hook_interface`'s own (private) seed constant —
/// duplicated here since it isn't exported, but the value is part of the
/// public interface spec and must match exactly for Token-2022 to find the
/// account it expects.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Seed for a client's per-client velocity-tracking PDA, derived as
/// `[VELOCITY_SEED, client_pubkey]`.
pub const VELOCITY_SEED: &[u8] = b"velocity";

/// Seed for the single, global sanctions-registry PDA.
pub const SANCTIONS_REGISTRY_SEED: &[u8] = b"sanctions-registry";

/// Fixed capacity for the sanctions registry (see state::sanctions_registry_space).
pub const MAX_SANCTIONS_ENTRIES: usize = 200;

pub const SANCTIONS_SOURCE_OFAC_SDN: u8 = 0;
pub const SANCTIONS_SOURCE_SYNTHETIC_TEST: u8 = 1;

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

/// SPL Memo program addresses accepted for the Travel Rule check — both the
/// original (v1) and current (v3) programs, matching Token-2022's own
/// MemoTransfer extension's convention of accepting either.
pub const MEMO_PROGRAM_V1: &str = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";
pub const MEMO_PROGRAM_V3: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/// Travel Rule memo format (spec-001.md: "formatted in the spirit of SWIFT
/// MT103 fields") — modeled on MT103's field *tags*, for recognizability to
/// anyone with banking-ops experience, not literal SWIFT network compliance
/// (MT103 was itself retired from the live SWIFT network in November 2025
/// in favor of ISO 20022's pacs.008 — see spec-001.md). A compact,
/// on-chain-parseable stand-in: four '|'-delimited fields, each prefixed
/// with its real MT103 tag, in order:
///
///   `:20:<transaction reference>|:50K:<ordering customer>|:59:<beneficiary customer>|:70:<remittance information>`
pub const TRAVEL_RULE_MEMO_DELIMITER: char = '|';
pub const TRAVEL_RULE_MEMO_TAGS: [&str; 4] = [":20:", ":50K:", ":59:", ":70:"];

/// Checks the raw bytes of a memo instruction's data against the Travel
/// Rule format above: exactly `TRAVEL_RULE_MEMO_TAGS.len()` fields, each
/// starting with its expected tag (in order) and carrying non-empty
/// content after it. No further SWIFT message-format validation is done —
/// this is a recognizable stand-in, not a SWIFT parser.
pub fn is_well_formed_travel_rule_memo(data: &[u8]) -> bool {
    let Ok(text) = core::str::from_utf8(data) else {
        return false;
    };
    let fields: Vec<&str> = text.split(TRAVEL_RULE_MEMO_DELIMITER).collect();
    if fields.len() != TRAVEL_RULE_MEMO_TAGS.len() {
        return false;
    }
    fields
        .iter()
        .zip(TRAVEL_RULE_MEMO_TAGS.iter())
        .all(|(field, tag)| match field.strip_prefix(tag) {
            Some(content) => !content.trim().is_empty(),
            None => false,
        })
}

/// Large-transaction flag threshold in integer cents ($10,000.00),
/// mirroring real CTR reporting thresholds (spec-001.md Move/transfer
/// flow, check 4). Non-blocking — flags, never reverts.
pub const LARGE_TRANSACTION_THRESHOLD_CENTS: u64 = 1_000_000;
