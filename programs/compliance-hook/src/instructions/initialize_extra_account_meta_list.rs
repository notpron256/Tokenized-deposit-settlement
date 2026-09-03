use anchor_lang::prelude::*;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::constants::{EXTRA_ACCOUNT_METAS_SEED, VELOCITY_SEED};
use crate::error::ComplianceHookError;

/// Index of the source account owner/delegate ("authority") within the base
/// four accounts every `Execute` call receives — per the Transfer Hook
/// interface's own fixed ordering (source, mint, destination, owner).
const EXECUTE_OWNER_ACCOUNT_INDEX: u8 = 3;

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
        space = ExtraAccountMetaList::size_of(1).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    /// CHECK: raw TLV account data, written via spl_tlv_account_resolution
    /// below rather than through Anchor's own (de)serialization.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Phase 1b: declares the sender's velocity account as the one extra account
/// every `Execute` call needs, resolved dynamically per-transfer from seeds
/// `[VELOCITY_SEED, <source account's owner>]` rather than a fixed pubkey —
/// Token-2022 (and any off-chain resolver) derives the correct address for
/// whichever client is transferring. Later phases (sanctions registry in 1d)
/// will need an `update_extra_account_meta_list` instruction to grow this
/// list further.
pub fn handle_initialize_extra_account_meta_list(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    let extra_account_metas = [ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal {
                bytes: VELOCITY_SEED.to_vec(),
            },
            Seed::AccountKey {
                index: EXECUTE_OWNER_ACCOUNT_INDEX,
            },
        ],
        false,
        true,
    )
    .map_err(|_| error!(ComplianceHookError::ExtraAccountMetaInitFailed))?];

    let mut account_data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut account_data, &extra_account_metas)
        .map_err(|_| error!(ComplianceHookError::ExtraAccountMetaInitFailed))?;
    Ok(())
}
