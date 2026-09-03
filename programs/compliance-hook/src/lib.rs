pub mod constants;
pub mod error;
pub mod instructions;

use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub use error::*;
pub use instructions::*;

declare_id!("9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z");

#[program]
pub mod compliance_hook {
    use super::*;

    /// Called once per mint (by us, not by Token-2022) during mint setup to
    /// create the Transfer Hook interface's extra-account-metas PDA. See
    /// instructions::initialize_extra_account_meta_list for detail.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        crate::instructions::initialize_extra_account_meta_list::handle_initialize_extra_account_meta_list(ctx)
    }

    /// Token-2022 CPIs into this program on every transfer using the raw
    /// Transfer Hook interface instruction format — NOT Anchor's own
    /// `global:<method>` discriminator scheme, which is why `execute` isn't
    /// a normal instruction above. Anchor's dispatcher falls through to this
    /// function whenever incoming instruction data doesn't match any
    /// `global:` discriminator, and we manually recognize the interface's
    /// own discriminators here instead.
    ///
    /// Phase 1a: all checks stubbed to pass. Real velocity (1b), Travel Rule
    /// memo (1c), sanctions re-screen (1d), and large-transaction flag (1e)
    /// checks are not implemented yet.
    pub fn fallback(_program_id: &Pubkey, _accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
        match TransferHookInstruction::unpack(data) {
            Ok(TransferHookInstruction::Execute { amount: _ }) => Ok(()),
            _ => Err(error!(ComplianceHookError::UnrecognizedFallbackInstruction)),
        }
    }
}
