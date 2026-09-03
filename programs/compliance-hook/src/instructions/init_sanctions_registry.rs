use anchor_lang::prelude::*;

use crate::constants::{MAX_SANCTIONS_ENTRIES, SANCTIONS_REGISTRY_SEED};
use crate::state::{sanctions_registry_space, SanctionsRegistry};

#[derive(Accounts)]
pub struct InitSanctionsRegistry<'info> {
    /// Becomes the registry's sync authority — the only signer who can call
    /// `update_sanctions_registry` afterward. Phase 1d doesn't hard-code who
    /// this must be, same reasoning as init_velocity_account: the real
    /// authority/custody model is still an open question (spec-001.md Areas
    /// of concern).
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = sanctions_registry_space(MAX_SANCTIONS_ENTRIES),
        seeds = [SANCTIONS_REGISTRY_SEED],
        bump,
    )]
    pub sanctions_registry: Account<'info, SanctionsRegistry>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_sanctions_registry(ctx: Context<InitSanctionsRegistry>) -> Result<()> {
    let registry = &mut ctx.accounts.sanctions_registry;
    registry.sync_authority = ctx.accounts.authority.key();
    registry.entries = vec![];
    Ok(())
}
