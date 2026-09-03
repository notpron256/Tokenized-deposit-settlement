/// Seed for the Transfer Hook interface's extra-account-metas PDA.
/// Mirrors `spl_transfer_hook_interface`'s own (private) seed constant —
/// duplicated here since it isn't exported, but the value is part of the
/// public interface spec and must match exactly for Token-2022 to find the
/// account it expects.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
