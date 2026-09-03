use anchor_lang::prelude::*;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::constants::EXTRA_ACCOUNT_METAS_SEED;
use crate::error::ComplianceHookError;

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// Mint authority for the Token-2022 mint this hook is attached to.
    /// Pays for and authorizes creation of the extra-account-metas PDA.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: only used as a PDA seed here; the mint itself isn't read or
    /// written by this instruction.
    pub mint: UncheckedAccount<'info>,

    /// The Transfer Hook interface's extra-account-metas PDA. Its address
    /// and TLV data format are dictated by the interface — Token-2022
    /// derives this same address independently before every transfer to
    /// find out what extra accounts to append to its `Execute` CPI.
    #[account(
        init,
        payer = authority,
        space = ExtraAccountMetaList::size_of(0).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    /// CHECK: raw TLV account data, written via spl_tlv_account_resolution
    /// below rather than through Anchor's own (de)serialization.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Phase 1a: writes an empty extra-accounts list — Execute doesn't need any
/// extra accounts yet, since its checks are all stubbed to pass. Later
/// phases (velocity account in 1b, sanctions registry in 1d) will need to
/// switch this to a non-empty list and add an `update_extra_account_meta_list`
/// instruction to grow it after those accounts exist.
pub fn handle_initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let mut account_data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut account_data, &[])
        .map_err(|_| error!(ComplianceHookError::ExtraAccountMetaInitFailed))?;
    Ok(())
}
