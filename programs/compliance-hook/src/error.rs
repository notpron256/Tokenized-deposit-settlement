use anchor_lang::prelude::*;

#[error_code]
pub enum ComplianceHookError {
    #[msg("Failed to write extra account meta list data")]
    ExtraAccountMetaInitFailed,
    #[msg("Instruction data did not match the Transfer Hook interface")]
    UnrecognizedFallbackInstruction,
}
