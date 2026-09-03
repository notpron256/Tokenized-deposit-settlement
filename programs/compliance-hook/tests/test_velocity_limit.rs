//! Phase 1b done-test: a transfer under the sender's hourly velocity cap
//! succeeds, and a transfer that would push the running total over the cap
//! reverts. Both go through a real Token-2022 mint with the Transfer Hook
//! extension pointing at this program, so Token-2022 itself invokes our
//! `execute` fallback via CPI — this isn't calling our check function
//! directly. Every transfer also needs a well-formed Travel Rule memo as of
//! Phase 1c — see common::memo_instruction.

mod common;

use solana_signer::Signer;
use spl_token_2022_interface::instruction as token_ix;

#[test]
fn test_velocity_limit() {
    let mut setup = common::setup(compliance_hook::RISK_MEDIUM);
    let extra_accounts = setup.extra_transfer_accounts();
    let memo = common::memo_instruction(
        ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );

    // --- Scenario 1: transfer $1,500,000.00 — under the $2,000,000/hr cap ---
    let mut ix_transfer_1 = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &setup.dest.pubkey(),
        &setup.client.pubkey(),
        &[],
        150_000_000,
        2,
    )
    .unwrap();
    ix_transfer_1.accounts.extend_from_slice(&extra_accounts);

    let result_1 = common::try_send(
        &mut setup.svm,
        &[memo.clone(), ix_transfer_1],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_1.is_ok(),
        "expected under-cap transfer ($1,500,000.00) to succeed: {:?}",
        result_1.err()
    );
    println!("PASS  transfer under velocity cap ($1,500,000.00 of $2,000,000.00/hr) succeeded");

    // --- Scenario 2: transfer $1,000,000.00 more — would bring the running
    // total to $2,500,000.00, over the $2,000,000/hr cap — must revert ---
    let mut ix_transfer_2 = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &setup.dest.pubkey(),
        &setup.client.pubkey(),
        &[],
        100_000_000,
        2,
    )
    .unwrap();
    ix_transfer_2.accounts.extend_from_slice(&extra_accounts);

    let result_2 = common::try_send(
        &mut setup.svm,
        &[memo, ix_transfer_2],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_2.is_err(),
        "expected over-cap transfer to revert, but it succeeded"
    );
    println!(
        "PASS  transfer over velocity cap (would reach $2,500,000.00 of $2,000,000.00/hr) reverted: {}",
        result_2.err().unwrap()
    );
}
