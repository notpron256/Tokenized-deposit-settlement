use anchor_lang::prelude::*;

use crate::constants::{velocity_cap_for_risk_rating, VELOCITY_SEED};
use crate::error::ComplianceHookError;
use crate::state::{VelocityAccount, VELOCITY_ACCOUNT_SPACE};

#[derive(Accounts)]
pub struct InitVelocityAccount<'info> {
    /// Compliance-controlled signer. Phase 1b doesn't hard-code who this must
    /// be — spec-001.md's authority/custody model is still an open question
    /// (see Areas of concern) — enforcing that only the real compliance
    /// service can call this is left to Phase 3's backend, not this program.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: the client this velocity account tracks; only used as a PDA
    /// seed, never read or written directly.
    pub client: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = VELOCITY_ACCOUNT_SPACE,
        seeds = [VELOCITY_SEED, client.key().as_ref()],
        bump,
    )]
    pub velocity_account: Account<'info, VelocityAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handle_init_velocity_account(
    ctx: Context<InitVelocityAccount>,
    risk_rating: u8,
) -> Result<()> {
    if velocity_cap_for_risk_rating(risk_rating).is_none() {
        return Err(error!(ComplianceHookError::InvalidRiskRating));
    }

    let velocity_account = &mut ctx.accounts.velocity_account;
    velocity_account.client = ctx.accounts.client.key();
    velocity_account.risk_rating = risk_rating;
    velocity_account.running_total = 0;
    velocity_account.window_start = Clock::get()?.unix_timestamp;
    Ok(())
}
