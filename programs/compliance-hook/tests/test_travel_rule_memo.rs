//! Phase 1c done-test: a transfer with no memo reverts, and a transfer with
//! a well-formed Travel Rule memo succeeds. Also covers a malformed memo
//! (present, but missing a required MT103 tag) reverting — not part of the
//! original plan-001.md done-test wording, but a necessary negative case
//! for the tagged-field format, added on request before committing it.
//! All three go through a real Token-2022 mint with the Transfer Hook
//! extension pointing at this program, so Token-2022 itself invokes our
//! `execute` fallback via CPI.

mod common;

use solana_signer::Signer;
use spl_token_2022_interface::instruction as token_ix;

#[test]
fn test_travel_rule_memo() {
    let mut setup = common::setup(compliance_hook::RISK_LOW);
    let extra_accounts = setup.extra_transfer_accounts();

    // --- Scenario 1: transfer with no preceding memo instruction at all —
    // must revert ---
    let mut ix_transfer_no_memo = token_ix::transfer_checked(
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
    ix_transfer_no_memo.accounts.extend_from_slice(&extra_accounts);

    let result_1 = common::try_send(
        &mut setup.svm,
        &[ix_transfer_no_memo],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_1.is_err(),
        "expected transfer with no memo to revert, but it succeeded"
    );
    println!(
        "PASS  transfer with no Travel Rule memo correctly reverted: {}",
        result_1.err().unwrap()
    );

    // --- Scenario 2: same transfer, now preceded by a well-formed Travel
    // Rule memo (MT103-style tagged fields :20:/:50K:/:59:/:70:) — must
    // succeed ---
    let memo = common::memo_instruction(
        ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );
    let mut ix_transfer_with_memo = token_ix::transfer_checked(
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
    ix_transfer_with_memo.accounts.extend_from_slice(&extra_accounts);

    let result_2 = common::try_send(
        &mut setup.svm,
        &[memo, ix_transfer_with_memo],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_2.is_ok(),
        "expected transfer with a well-formed Travel Rule memo to succeed: {:?}",
        result_2.err()
    );
    println!("PASS  transfer with well-formed Travel Rule memo succeeded");

    // --- Scenario 3: transfer preceded by a memo that's present but
    // malformed — missing the :50K: (ordering customer) tag entirely, so
    // only 3 of the 4 required tagged fields are there — must revert ---
    let malformed_memo =
        common::memo_instruction(":20:INV4521|Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521");
    let mut ix_transfer_malformed_memo = token_ix::transfer_checked(
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
    ix_transfer_malformed_memo.accounts.extend_from_slice(&extra_accounts);

    let result_3 = common::try_send(
        &mut setup.svm,
        &[malformed_memo, ix_transfer_malformed_memo],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_3.is_err(),
        "expected transfer with a malformed Travel Rule memo (missing :50K: tag) to revert, but it succeeded"
    );
    println!(
        "PASS  transfer with malformed Travel Rule memo (missing :50K: tag) correctly reverted: {}",
        result_3.err().unwrap()
    );

    // --- Scenario 4: transfer preceded by a memo with all four tags
    // present but one field left empty (:59: has no content) — must
    // revert. This specifically exercises the non-empty-content check,
    // which a field-count-only check wouldn't catch. ---
    let empty_field_memo = common::memo_instruction(
        ":20:INV4521|:50K:Acme Corp Treasury|:59:|:70:Invoice #4521",
    );
    let mut ix_transfer_empty_field = token_ix::transfer_checked(
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
    ix_transfer_empty_field.accounts.extend_from_slice(&extra_accounts);

    let result_4 = common::try_send(
        &mut setup.svm,
        &[empty_field_memo, ix_transfer_empty_field],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    assert!(
        result_4.is_err(),
        "expected transfer with an empty :59: field to revert, but it succeeded"
    );
    println!(
        "PASS  transfer with empty :59: (beneficiary) field correctly reverted: {}",
        result_4.err().unwrap()
    );
}
