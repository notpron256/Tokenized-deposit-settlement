use anchor_lang::prelude::*;

#[error_code]
pub enum ComplianceHookError {
    #[msg("Failed to write extra account meta list data")]
    ExtraAccountMetaInitFailed,
    #[msg("Instruction data did not match the Transfer Hook interface")]
    UnrecognizedFallbackInstruction,
    #[msg("Risk rating must be 0 (low), 1 (medium), or 2 (high)")]
    InvalidRiskRating,
    #[msg("Execute was not given the expected velocity account as an extra account")]
    MissingVelocityAccount,
    #[msg("The provided velocity account does not match the expected PDA for this client")]
    InvalidVelocityAccount,
    #[msg("Transfer would exceed the client's hourly velocity limit")]
    VelocityLimitExceeded,
}
