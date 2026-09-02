//! THROWAWAY spike program — not part of the real system, not kept past
//! Phase 0.5. Live-tests whether a burn-gateway pattern can require two
//! specific co-signers (client + bank compliance signer) on burn alone,
//! without making the token account's own `owner` a shared multisig —
//! which would also gate ordinary transfers, defeating the Transfer Hook's
//! whole point. See plan-001.md Phase 0.5 and spec-001.md Redeem/burn flow.
//!
//! Mechanism under test:
//! 1. The client's ATA owner stays their own single key (untouched).
//! 2. The client `Approve`s this program's PDA as the ATA's delegate.
//! 3. `redeem` requires BOTH `client` and `compliance_signer` as Anchor
//!    `Signer`s — enforced before the handler body even runs.
//! 4. Only then does it CPI into the base SPL Token `Burn` instruction,
//!    authorized by the PDA delegate via `invoke_signed`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

declare_id!("BjJxEvxGX68pLDTEQSKFLssXEqtjMZWheW8xbCRkBJaa");

const GATEWAY_SEED: &[u8] = b"gateway";

#[program]
pub mod redeem_gateway_spike {
    use super::*;

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.gateway_authority;
        let seeds: &[&[u8]] = &[GATEWAY_SEED, &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];

        // Base SPL Token `Burn` instruction (TokenInstruction::Burn = 8),
        // authorized by our PDA, which the client approved as delegate
        // off-chain before calling this instruction.
        let mut data = Vec::with_capacity(9);
        data.push(8u8);
        data.extend_from_slice(&amount.to_le_bytes());

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

        msg!("Redeemed {} via gateway, co-signed by client + compliance", amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub client: Signer<'info>,
    pub compliance_signer: Signer<'info>,
    /// CHECK: PDA used purely as a delegate authority for CPI signing;
    /// approved as the token account's delegate off-chain before this call.
    #[account(seeds = [GATEWAY_SEED], bump)]
    pub gateway_authority: UncheckedAccount<'info>,
    /// CHECK: validated implicitly by the token program during the CPI
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: validated implicitly by the token program during the CPI
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: must be the Token-2022 program; passed explicitly rather than
    /// hardcoded so this spike doesn't depend on a specific SDK macro
    pub token_program: UncheckedAccount<'info>,
}
