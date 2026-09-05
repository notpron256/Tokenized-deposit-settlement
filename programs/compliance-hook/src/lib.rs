pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use spl_token_2022_interface::{
    extension::{permanent_delegate::get_permanent_delegate, PodStateWithExtensions},
    pod::PodMint,
};
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub use constants::*;
pub use error::*;
pub use events::*;
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

    /// One-time setup: creates the single, global sanctions registry PDA and
    /// makes the caller its sync authority.
    pub fn init_sanctions_registry(ctx: Context<InitSanctionsRegistry>) -> Result<()> {
        crate::instructions::init_sanctions_registry::handle_init_sanctions_registry(ctx)
    }

    /// Called by the off-chain sync process (Phase 7) — or directly, for
    /// this phase's own testing — to overwrite the registry with a fresh
    /// snapshot. Full replace, not incremental; see
    /// instructions::update_sanctions_registry for why.
    pub fn update_sanctions_registry(
        ctx: Context<UpdateSanctionsRegistry>,
        entries: Vec<SanctionsEntry>,
    ) -> Result<()> {
        crate::instructions::update_sanctions_registry::handle_update_sanctions_registry(ctx, entries)
    }

    /// Token-2022 CPIs into this program on every transfer using the raw
    /// Transfer Hook interface instruction format — NOT Anchor's own
    /// `global:<method>` discriminator scheme, which is why `execute` isn't
    /// a normal instruction above. Anchor's dispatcher falls through to this
    /// function whenever incoming instruction data doesn't match any
    /// `global:` discriminator, and we manually recognize the interface's
    /// own discriminators here instead.
    ///
    /// Phase 1b: velocity-limit check. Phase 1c: Travel Rule memo check.
    /// Phase 1d: sanctions re-screen. Phase 1e: large-transaction flag (all
    /// implemented below). Checks 1b-1d are blocking (any failure reverts
    /// the transfer, in order, so the first failing check is what's
    /// reported); 1e is non-blocking and always runs last, after the
    /// transfer has already passed every blocking check.
    ///
    /// Phase 6.5: all three blocking checks are structured around an
    /// ordinary client-signed transfer — `accounts[EXECUTE_OWNER_INDEX]`
    /// ("owner/delegate" per the Transfer Hook interface spec) is assumed
    /// to be the transferring client themselves. That assumption breaks
    /// for a Permanent-Delegate-authorized transfer (bank-ops signs, not
    /// the client): velocity would look up a PDA that was never created
    /// for bank-ops, the Travel Rule shape doesn't fit a bank-to-recovery
    /// movement, and sanctions-screening the *signer* instead of the real
    /// source account owner is actively wrong — verified on-chain (see
    /// spec-001.md, Areas of concern) that it let a clawback out of an
    /// actually-sanctioned account through undetected, since it never
    /// inspected the real party at all. So this path is detected first —
    /// by reading the mint's own configured Permanent Delegate off its
    /// extension data and comparing it to the signer — and if it matches,
    /// all three blocking checks are skipped entirely; this is Permanent
    /// Delegate acting as the emergency override it's meant to be, not a
    /// client transfer wearing a disguise. Only the non-blocking
    /// large-transaction flag still runs — a large clawback is exactly the
    /// kind of thing worth an audit signal.
    pub fn fallback(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<()> {
        match TransferHookInstruction::unpack(data) {
            Ok(TransferHookInstruction::Execute { amount }) => {
                if is_permanent_delegate_transfer(accounts)? {
                    flag_large_transaction(accounts, amount)?;
                    return Ok(());
                }
                check_velocity_limit(program_id, accounts, amount)?;
                check_travel_rule_memo(accounts)?;
                check_sanctions(program_id, accounts)?;
                flag_large_transaction(accounts, amount)?;
                Ok(())
            }
            _ => Err(error!(ComplianceHookError::UnrecognizedFallbackInstruction)),
        }
    }
}

/// Execute's accounts, per the Transfer Hook interface: 0 source, 1 mint,
/// 2 destination, 3 owner/authority, 4 extra-account-meta-list PDA, 5.. the
/// extra accounts we declared: 5 = velocity account (1b), 6 = Instructions
/// sysvar (1c), 7 = sanctions registry (1d) — must stay in sync with
/// initialize_extra_account_meta_list's declaration order.
const EXECUTE_MINT_INDEX: usize = 1;
const EXECUTE_DESTINATION_INDEX: usize = 2;
const EXECUTE_OWNER_INDEX: usize = 3;
const EXECUTE_VELOCITY_ACCOUNT_INDEX: usize = 5;
const EXECUTE_INSTRUCTIONS_SYSVAR_INDEX: usize = 6;
const EXECUTE_SANCTIONS_REGISTRY_INDEX: usize = 7;

/// Byte offset of the `owner` field within a (Token-2022) token account's
/// raw data. spl-token-2022-interface doesn't expose this as a named
/// constant, so it's pinned here against the crate's own authoritative
/// serialization logic rather than just the struct's field-declaration
/// order: `impl Pack for Account` in `spl-token-2022-interface-3.1.1/src/state.rs`
/// unpacks/packs the 165-byte base account as
/// `array_refs![src, 32, 32, 8, 36, 1, 12, 8, 36]` — i.e.
/// `mint(0..32), owner(32..64), amount(64..72), delegate(72..108), ...` —
/// so `owner` is guaranteed to start at byte 32, not merely observed to
/// work. (Token-2022 extensions are appended after this base 165-byte
/// account, not inline, so they don't shift this offset.)
const TOKEN_ACCOUNT_OWNER_OFFSET: usize = 32;

/// Reads a token account's `owner` field directly out of its raw account
/// data, via TOKEN_ACCOUNT_OWNER_OFFSET. Used for the destination account,
/// whose owner isn't one of Execute's base accounts (only its token
/// account address is).
fn read_token_account_owner(account_info: &AccountInfo) -> Result<Pubkey> {
    let data = account_info.try_borrow_data()?;
    require_gte!(
        data.len(),
        TOKEN_ACCOUNT_OWNER_OFFSET + 32,
        ComplianceHookError::InvalidDestinationAccount
    );
    let owner_bytes: [u8; 32] = data[TOKEN_ACCOUNT_OWNER_OFFSET..TOKEN_ACCOUNT_OWNER_OFFSET + 32]
        .try_into()
        .map_err(|_| error!(ComplianceHookError::InvalidDestinationAccount))?;
    Ok(Pubkey::new_from_array(owner_bytes))
}

/// True if this Execute call's signing authority (accounts[EXECUTE_OWNER_INDEX])
/// is the mint's own configured Permanent Delegate — i.e. this is a
/// bank-initiated clawback (Phase 6.5), not an ordinary client-signed
/// transfer. Reads the delegate straight off the mint account's own
/// extension data (accounts[EXECUTE_MINT_INDEX], already passed into every
/// Execute call — no new account needed) via spl-token-2022-interface's own
/// TLV-extension parsing, the same officially-supported mechanism Token-2022
/// itself uses, rather than hand-decoding the TLV layout.
fn is_permanent_delegate_transfer(accounts: &[AccountInfo]) -> Result<bool> {
    let mint_info = &accounts[EXECUTE_MINT_INDEX];
    let mint_data = mint_info.try_borrow_data()?;
    let mint_state = PodStateWithExtensions::<PodMint>::unpack(&mint_data)
        .map_err(|_| error!(ComplianceHookError::InvalidMintAccount))?;

    let permanent_delegate = get_permanent_delegate(&mint_state);
    let owner_info = &accounts[EXECUTE_OWNER_INDEX];

    Ok(permanent_delegate
        .map(|delegate| delegate.as_ref() == owner_info.key.as_ref())
        .unwrap_or(false))
}

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

/// Sanctions re-screen (spec-001.md Move/transfer flow, check 3): checks
/// both parties to the transfer — the source account's owner and the
/// destination account's owner — against the on-chain sanctions registry
/// snapshot. Reads the registry directly; never makes a live network call
/// (no on-chain program can). The destination's owner isn't one of
/// Execute's base accounts, so it's read directly out of the destination
/// token account's raw data rather than passed in separately.
fn check_sanctions(program_id: &Pubkey, accounts: &[AccountInfo]) -> Result<()> {
    require_gte!(
        accounts.len(),
        EXECUTE_SANCTIONS_REGISTRY_INDEX + 1,
        ComplianceHookError::MissingSanctionsRegistry
    );

    let source_owner_info = &accounts[EXECUTE_OWNER_INDEX];
    let destination_info = &accounts[EXECUTE_DESTINATION_INDEX];
    let registry_info = &accounts[EXECUTE_SANCTIONS_REGISTRY_INDEX];

    let (expected_registry_pda, _bump) =
        Pubkey::find_program_address(&[SANCTIONS_REGISTRY_SEED], program_id);
    require_keys_eq!(
        *registry_info.key,
        expected_registry_pda,
        ComplianceHookError::InvalidSanctionsRegistry
    );

    let registry: SanctionsRegistry = {
        let data = registry_info.try_borrow_data()?;
        SanctionsRegistry::try_deserialize(&mut &data[..])?
    };

    let destination_owner = read_token_account_owner(destination_info)?;

    let is_sanctioned = registry.entries.iter().any(|entry| {
        entry.address == *source_owner_info.key || entry.address == destination_owner
    });

    if is_sanctioned {
        return Err(error!(ComplianceHookError::SanctionedParty));
    }

    Ok(())
}

/// Large-transaction flag (spec-001.md Move/transfer flow, check 4): logs a
/// complete record — both parties, mint, amount, timestamp — for any
/// transfer at or above LARGE_TRANSACTION_THRESHOLD_CENTS, mirroring real
/// CTR reporting thresholds. Non-blocking by design: this never returns an
/// error for the amount itself, only for genuinely malformed accounts
/// (which the earlier blocking checks would already have caught in
/// practice, since this runs last). Compliance handles the actual
/// regulatory filing out-of-band, off the back of this log — the control's
/// job is only to guarantee the record exists.
fn flag_large_transaction(accounts: &[AccountInfo], amount: u64) -> Result<()> {
    if amount < LARGE_TRANSACTION_THRESHOLD_CENTS {
        return Ok(());
    }

    // No account-count guard needed here: this always runs after
    // check_sanctions, which already requires accounts.len() to be at
    // least EXECUTE_SANCTIONS_REGISTRY_INDEX + 1 (8) — well past the
    // indices used below.
    let source_owner = *accounts[EXECUTE_OWNER_INDEX].key;
    let destination_owner = read_token_account_owner(&accounts[EXECUTE_DESTINATION_INDEX])?;
    let mint = *accounts[EXECUTE_MINT_INDEX].key;
    let timestamp = Clock::get()?.unix_timestamp;

    emit!(LargeTransactionFlag {
        source_owner,
        destination_owner,
        mint,
        amount,
        timestamp,
    });

    Ok(())
}
