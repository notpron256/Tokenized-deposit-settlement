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
    #[msg("Execute was not given the Instructions sysvar as an extra account")]
    MissingInstructionsSysvar,
    #[msg("The provided account is not the real Instructions sysvar")]
    InvalidInstructionsSysvar,
    #[msg("Transfer must be immediately preceded by a well-formed Travel Rule memo: :20:<transaction reference>|:50K:<ordering customer>|:59:<beneficiary customer>|:70:<remittance information>")]
    MissingOrInvalidTravelRuleMemo,
    #[msg("Sanctions registry already has the maximum number of entries")]
    SanctionsRegistryFull,
    #[msg("Execute was not given the sanctions registry as an extra account")]
    MissingSanctionsRegistry,
    #[msg("The provided account is not the real sanctions registry PDA")]
    InvalidSanctionsRegistry,
    #[msg("Destination account data is too short to read its owner")]
    InvalidDestinationAccount,
    #[msg("Transfer involves a sanctioned party")]
    SanctionedParty,
}
