pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub use constants::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

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

    /// Called by the compliance service (Phase 3 onboarding) to initialize a
    /// client's velocity-tracking PDA with their assigned risk rating.
    pub fn init_velocity_account(
        ctx: Context<InitVelocityAccount>,
        risk_rating: u8,
    ) -> Result<()> {
        crate::instructions::init_velocity_account::handle_init_velocity_account(ctx, risk_rating)
    }

    /// Token-2022 CPIs into this program on every transfer using the raw
    /// Transfer Hook interface instruction format — NOT Anchor's own
    /// `global:<method>` discriminator scheme, which is why `execute` isn't
    /// a normal instruction above. Anchor's dispatcher falls through to this
    /// function whenever incoming instruction data doesn't match any
    /// `global:` discriminator, and we manually recognize the interface's
    /// own discriminators here instead.
    ///
    /// Phase 1b: velocity-limit check implemented (this function). Travel
    /// Rule memo (1c), sanctions re-screen (1d), and large-transaction flag
    /// (1e) checks are not implemented yet.
    pub fn fallback(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
        match TransferHookInstruction::unpack(data) {
            Ok(TransferHookInstruction::Execute { amount }) => {
                check_velocity_limit(program_id, accounts, amount)
            }
            _ => Err(error!(ComplianceHookError::UnrecognizedFallbackInstruction)),
        }
    }
}

/// Execute's accounts, per the Transfer Hook interface: 0 source, 1 mint,
/// 2 destination, 3 owner/authority, 4 extra-account-meta-list PDA, 5.. the
/// extra accounts we declared (just the sender's velocity account, so far).
const EXECUTE_OWNER_INDEX: usize = 3;
const EXECUTE_VELOCITY_ACCOUNT_INDEX: usize = 5;

fn check_velocity_limit(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> Result<()> {
    require_gte!(
        accounts.len(),
        EXECUTE_VELOCITY_ACCOUNT_INDEX + 1,
        ComplianceHookError::MissingVelocityAccount
    );

    let owner_info = &accounts[EXECUTE_OWNER_INDEX];
    let velocity_account_info = &accounts[EXECUTE_VELOCITY_ACCOUNT_INDEX];

    let (expected_velocity_pda, _bump) =
        Pubkey::find_program_address(&[VELOCITY_SEED, owner_info.key.as_ref()], program_id);
    require_keys_eq!(
        *velocity_account_info.key,
        expected_velocity_pda,
        ComplianceHookError::InvalidVelocityAccount
    );

    let mut velocity_state: VelocityAccount = {
        let data = velocity_account_info.try_borrow_data()?;
        VelocityAccount::try_deserialize(&mut &data[..])?
    };

    let cap = velocity_cap_for_risk_rating(velocity_state.risk_rating)
        .ok_or_else(|| error!(ComplianceHookError::InvalidRiskRating))?;

    let now = Clock::get()?.unix_timestamp;
    if now.saturating_sub(velocity_state.window_start) >= VELOCITY_WINDOW_SECONDS {
        velocity_state.running_total = 0;
        velocity_state.window_start = now;
    }

    let new_total = velocity_state
        .running_total
        .checked_add(amount)
        .ok_or_else(|| error!(ComplianceHookError::VelocityLimitExceeded))?;
    if new_total > cap {
        return Err(error!(ComplianceHookError::VelocityLimitExceeded));
    }
    velocity_state.running_total = new_total;

    {
        let mut data = velocity_account_info.try_borrow_mut_data()?;
        velocity_state.try_serialize(&mut &mut data[..])?;
    }

    Ok(())
}
