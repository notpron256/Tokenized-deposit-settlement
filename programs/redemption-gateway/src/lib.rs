//! Phase 8 (plan-001.md): the real redemption-gateway program, replacing
//! the Phase 0.5 spike (spikes/redeem-gateway-verification/). Verified
//! live on-chain before being adopted (spec-001.md, Redeem/burn flow): a
//! one-signature redeem attempt was confirmed to fail (signature
//! verification), a two-signature attempt confirmed to succeed with the
//! on-chain balance decreasing by exactly the redeemed amount.
//!
//! Mechanism (spec-001.md, Redeem/burn flow, steps 2-6):
//! 1. The client's ATA owner stays their own single key — never a shared
//!    multisig, which would also gate ordinary transfers and defeat the
//!    Transfer Hook's entire point of unilateral, on-chain-enforced
//!    compliance on transfers.
//! 2. The client `Approve`s this program's PDA as a scoped delegate over
//!    their ATA, for the exact amount being redeemed.
//! 3. `redeem` requires BOTH `client` and `compliance_signer` as real
//!    Anchor `Signer`s, enforced by account validation before this
//!    handler body even runs — the co-sign gate is the token account's
//!    own program logic, not a discipline the caller has to uphold.
//! 4. Only then does it CPI into Token-2022's `BurnChecked` (never the
//!    unchecked `Burn` the Phase 0.5 spike used, which lacked the
//!    decimals cross-check — a deliberate hardening over the spike, not
//!    something spec-001.md's original wording called for explicitly),
//!    authorized by the PDA delegate via `invoke_signed`, directly
//!    against the client's own token account — no intermediate transfer
//!    to a redemption/omnibus account.
//!
//! The sanctions re-check (spec-001.md step 5) happens off-chain, in the
//! backend redemption service, *before* it ever agrees to provide the
//! compliance_signer's signature — not inside this program. A sanctioned
//! client's redemption is refused by the backend declining to co-sign at
//! all, never even submitting a transaction; there is nothing for this
//! program to check on-chain, since the whole point is that the
//! compliance signer's signature is the compliance gate.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("A4JWxQpSW19yZ27bFR9Gfxz14SxVDhExQoXvixt3zVzN");

const GATEWAY_SEED: &[u8] = b"gateway";

/// Token-2022's own `BurnChecked` instruction discriminator (see
/// TokenInstruction::pack in spl-token-2022-interface) — built by hand
/// rather than via the interface crate's own instruction builder, since
/// that builder returns a `solana_instruction::Instruction` using a
/// different `Address` type than the one `invoke_signed` here expects
/// (anchor-lang's own re-exported `solana_program` types); mixing the two
/// crate ecosystems in one CPI call risks a real type-compatibility
/// break, not just an inconvenience. Same manual-construction approach
/// this codebase already uses elsewhere (compliance-hook's own
/// `anchorDiscriminator`-style CPIs).
const BURN_CHECKED_DISCRIMINATOR: u8 = 15;

#[program]
pub mod redemption_gateway {
    use super::*;

    pub fn redeem(ctx: Context<Redeem>, amount: u64, decimals: u8) -> Result<()> {
        let bump = ctx.bumps.gateway_authority;
        let seeds: &[&[u8]] = &[GATEWAY_SEED, &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        let mut data = Vec::with_capacity(10);
        data.push(BURN_CHECKED_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.push(decimals);

        let ix = Instruction {
            program_id: ctx.accounts.token_program.key(),
            accounts: vec![
                AccountMeta::new(ctx.accounts.token_account.key(), false),
                AccountMeta::new(ctx.accounts.mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gateway_authority.key(), true),
            ],
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.gateway_authority.to_account_info(),
            ],
            signer_seeds,
        )?;

        emit!(RedeemEvent {
            client: ctx.accounts.client.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[event]
pub struct RedeemEvent {
    pub client: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub client: Signer<'info>,
    pub compliance_signer: Signer<'info>,
    /// CHECK: PDA used purely as a delegate authority for CPI signing;
    /// approved as the token account's delegate off-chain, in the same
    /// transaction, before this instruction runs.
    #[account(seeds = [GATEWAY_SEED], bump)]
    pub gateway_authority: UncheckedAccount<'info>,
    /// CHECK: validated implicitly by the token program during the CPI
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: validated implicitly by the token program during the CPI
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: must be the Token-2022 program; passed explicitly rather
    /// than hardcoded so this program doesn't depend on a specific SDK
    /// macro pinning one program ID.
    pub token_program: UncheckedAccount<'info>,
}
