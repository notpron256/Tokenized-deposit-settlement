use anchor_lang::prelude::*;

use crate::constants::{MAX_SANCTIONS_ENTRIES, SANCTIONS_REGISTRY_SEED};
use crate::error::ComplianceHookError;
use crate::state::{SanctionsEntry, SanctionsRegistry};

#[derive(Accounts)]
pub struct UpdateSanctionsRegistry<'info> {
    pub sync_authority: Signer<'info>,

    /// Full-overwrite update, matching spec-001.md's description of the
    /// off-chain sync process: it fetches the whole current OFAC SDN list
    /// each run and writes the complete filtered snapshot, not an
    /// incremental patch. Preserving a previously-seeded synthetic test
    /// entry across a real sync is the *caller's* responsibility (Phase 7),
    /// not something this instruction special-cases.
    #[account(
        mut,
        seeds = [SANCTIONS_REGISTRY_SEED],
        bump,
        has_one = sync_authority,
    )]
    pub sanctions_registry: Account<'info, SanctionsRegistry>,
}

pub fn handle_update_sanctions_registry(
    ctx: Context<UpdateSanctionsRegistry>,
    entries: Vec<SanctionsEntry>,
) -> Result<()> {
    if entries.len() > MAX_SANCTIONS_ENTRIES {
        return Err(error!(ComplianceHookError::SanctionsRegistryFull));
    }
    ctx.accounts.sanctions_registry.entries = entries;
    Ok(())
}
