//! Phase 1d done-test: seeds one entry tagged SyntheticTest into the
//! sanctions registry, shows a transfer involving it reverting, and an
//! unrelated transfer succeeding. Both go through a real Token-2022 mint
//! with the Transfer Hook extension pointing at this program, so
//! Token-2022 itself invokes our `execute` fallback via CPI.

mod common;

use anchor_lang::{InstructionData, ToAccountMetas};
use solana_signer::Signer;
use spl_token_2022_interface::{extension::ExtensionType, instruction as token_ix};

#[test]
fn test_sanctions_registry() {
    let mut setup = common::setup(compliance_hook::RISK_LOW);
    let extra_accounts = setup.extra_transfer_accounts();
    let memo = || {
        common::memo_instruction(
            ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
        )
    };

    // --- Seed the registry with dest_owner as a SyntheticTest entry ---
    let ix_update_sanctions = common::to_sol_instruction(
        setup.hook_program_id,
        compliance_hook::accounts::UpdateSanctionsRegistry {
            sync_authority: common::addr_to_anchor_pubkey(setup.payer.pubkey()),
            sanctions_registry: setup.sanctions_registry,
        }
        .to_account_metas(None),
        compliance_hook::instruction::UpdateSanctionsRegistry {
            entries: vec![compliance_hook::SanctionsEntry {
                address: common::addr_to_anchor_pubkey(setup.dest_owner.pubkey()),
                source: compliance_hook::SANCTIONS_SOURCE_SYNTHETIC_TEST,
            }],
        }
        .data(),
    );
    common::send(&mut setup.svm, &[ix_update_sanctions], &setup.payer.pubkey(), &[&setup.payer]);

    // --- Scenario 1: transfer to the sanctioned destination — must revert ---
    let mut ix_transfer_sanctioned = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &setup.dest.pubkey(),
        &setup.client.pubkey(),
        &[],
        10_000_00, // $10,000.00
        2,
    )
    .unwrap();
    ix_transfer_sanctioned.accounts.extend_from_slice(&extra_accounts);

    let result_1 = common::try_send(
        &mut setup.svm,
        &[memo(), ix_transfer_sanctioned],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_1.is_err(),
        "expected transfer to a sanctioned party to revert, but it succeeded"
    );
    println!(
        "PASS  transfer to sanctioned (SyntheticTest) destination correctly reverted: {}",
        result_1.err().unwrap()
    );

    // --- Scenario 2: transfer to an unrelated, non-sanctioned destination —
    // must succeed. Proves the registry blocks by address match, not just
    // "any registry entry exists". ---
    let dest2_owner = solana_keypair::Keypair::new();
    setup
        .svm
        .airdrop(&dest2_owner.pubkey(), 1_000_000_000)
        .unwrap();
    let dest2 = solana_keypair::Keypair::new();
    let token_account_len =
        ExtensionType::try_calculate_account_len::<spl_token_2022_interface::state::Account>(&[
            ExtensionType::TransferHookAccount,
        ])
        .unwrap();
    let token_account_rent = setup.svm.minimum_balance_for_rent_exemption(token_account_len);
    let ix_create_dest2 = anchor_lang::solana_program::system_instruction::create_account(
        &common::addr_to_anchor_pubkey(setup.payer.pubkey()),
        &common::addr_to_anchor_pubkey(dest2.pubkey()),
        token_account_rent,
        token_account_len as u64,
        &common::addr_to_anchor_pubkey(setup.token_program_id),
    );
    let ix_create_dest2 =
        common::to_sol_instruction(ix_create_dest2.program_id, ix_create_dest2.accounts, ix_create_dest2.data);
    let ix_init_dest2 = token_ix::initialize_account3(
        &setup.token_program_id,
        &dest2.pubkey(),
        &setup.mint.pubkey(),
        &dest2_owner.pubkey(),
    )
    .unwrap();
    common::send(
        &mut setup.svm,
        &[ix_create_dest2, ix_init_dest2],
        &setup.payer.pubkey(),
        &[&setup.payer, &dest2],
    );

    let mut ix_transfer_unrelated = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &dest2.pubkey(),
        &setup.client.pubkey(),
        &[],
        10_000_00, // $10,000.00
        2,
    )
    .unwrap();
    ix_transfer_unrelated.accounts.extend_from_slice(&extra_accounts);

    let result_2 = common::try_send(
        &mut setup.svm,
        &[memo(), ix_transfer_unrelated],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_2.is_ok(),
        "expected unrelated transfer to a non-sanctioned destination to succeed: {:?}",
        result_2.err()
    );
    println!("PASS  unrelated transfer to a non-sanctioned destination succeeded");
}
