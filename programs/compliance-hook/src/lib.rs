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
    /// Phase 1b: velocity-limit check. Phase 1c: Travel Rule memo check
    /// (both implemented below). Sanctions re-screen (1d) and large-
    /// transaction flag (1e) checks are not implemented yet.
    pub fn fallback(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
        match TransferHookInstruction::unpack(data) {
            Ok(TransferHookInstruction::Execute { amount }) => {
                check_velocity_limit(program_id, accounts, amount)?;
                check_travel_rule_memo(accounts)?;
                Ok(())
            }
            _ => Err(error!(ComplianceHookError::UnrecognizedFallbackInstruction)),
        }
    }
}

/// Execute's accounts, per the Transfer Hook interface: 0 source, 1 mint,
/// 2 destination, 3 owner/authority, 4 extra-account-meta-list PDA, 5.. the
/// extra accounts we declared: 5 = velocity account (1b), 6 = Instructions
/// sysvar (1c) — must stay in sync with initialize_extra_account_meta_list's
/// declaration order.
const EXECUTE_OWNER_INDEX: usize = 3;
const EXECUTE_VELOCITY_ACCOUNT_INDEX: usize = 5;
const EXECUTE_INSTRUCTIONS_SYSVAR_INDEX: usize = 6;

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

/// Travel Rule check (spec-001.md Move/transfer flow, check 2): the transfer
/// must be immediately preceded, in the same transaction, by an SPL Memo
/// instruction carrying well-formed originator/beneficiary/purpose data.
/// This is Token-2022's own `MemoTransfer` account extension's job to
/// require *a* memo be present; this check goes further and validates its
/// *structure*, via instruction introspection (the Instructions sysvar) —
/// not by reading the mint/account extension state at all.
fn check_travel_rule_memo(accounts: &[AccountInfo]) -> Result<()> {
    require_gte!(
        accounts.len(),
        EXECUTE_INSTRUCTIONS_SYSVAR_INDEX + 1,
        ComplianceHookError::MissingInstructionsSysvar
    );

    let instructions_sysvar_info = &accounts[EXECUTE_INSTRUCTIONS_SYSVAR_INDEX];
    require_keys_eq!(
        *instructions_sysvar_info.key,
        solana_instructions_sysvar::ID,
        ComplianceHookError::InvalidInstructionsSysvar
    );

    let preceding_ix = solana_instructions_sysvar::get_instruction_relative(-1, instructions_sysvar_info)
        .map_err(|_| error!(ComplianceHookError::MissingOrInvalidTravelRuleMemo))?;

    let memo_v1: Pubkey = MEMO_PROGRAM_V1.parse().unwrap();
    let memo_v3: Pubkey = MEMO_PROGRAM_V3.parse().unwrap();
    let is_memo_program = preceding_ix.program_id == memo_v1 || preceding_ix.program_id == memo_v3;

    if !is_memo_program || !is_well_formed_travel_rule_memo(&preceding_ix.data) {
        return Err(error!(ComplianceHookError::MissingOrInvalidTravelRuleMemo));
    }

    Ok(())
}
