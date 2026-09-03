//! Phase 1e done-test: a transfer of $10,000.00 or more succeeds, and an
//! emitted flag (event) is captured in the test output. Goes through a
//! real Token-2022 mint with the Transfer Hook extension pointing at this
//! program, so Token-2022 itself invokes our `execute` fallback via CPI.
//! Also confirms a transfer *below* the threshold does NOT emit the flag —
//! the negative case for this specific behavior (per AGENTS.md's
//! negative-case-coverage norm): "non-blocking" only means it doesn't
//! revert, not that it doesn't matter whether the flag fires correctly.

mod common;

use solana_signer::Signer;
use spl_token_2022_interface::instruction as token_ix;

#[test]
fn test_large_transaction_flag() {
    let mut setup = common::setup(compliance_hook::RISK_LOW);
    let extra_accounts = setup.extra_transfer_accounts();
    let memo = || {
        common::memo_instruction(
            ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
        )
    };

    // --- Scenario 1: transfer of exactly $10,000.00 (the threshold) —
    // must succeed, and the flag must be emitted ---
    let mut ix_transfer_large = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &setup.dest.pubkey(),
        &setup.client.pubkey(),
        &[],
        10_000_00, // $10,000.00 — exactly at the threshold
        2,
    )
    .unwrap();
    ix_transfer_large.accounts.extend_from_slice(&extra_accounts);

    let logs = common::send_capturing_logs(
        &mut setup.svm,
        &[memo(), ix_transfer_large],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    let emitted = logs.iter().any(|line| line.starts_with("Program data: "));
    assert!(
        emitted,
        "expected a LargeTransactionFlag event (a 'Program data: ...' log line) for a $10,000.00 transfer, but none was found in: {logs:?}"
    );
    println!("PASS  $10,000.00 transfer succeeded and emitted a LargeTransactionFlag event");
    println!(
        "      {}",
        logs.iter().find(|line| line.starts_with("Program data: ")).unwrap()
    );

    // --- Scenario 2: transfer of $9,999.99 — just under the threshold —
    // must succeed, and must NOT emit the flag ---
    let mut ix_transfer_small = token_ix::transfer_checked(
        &setup.token_program_id,
        &setup.source.pubkey(),
        &setup.mint.pubkey(),
        &setup.dest.pubkey(),
        &setup.client.pubkey(),
        &[],
        9_999_99, // $9,999.99 — just under the threshold
        2,
    )
    .unwrap();
    ix_transfer_small.accounts.extend_from_slice(&extra_accounts);

    let logs_small = common::send_capturing_logs(
        &mut setup.svm,
        &[memo(), ix_transfer_small],
        &setup.payer.pubkey(),
        &[&setup.payer, &setup.client],
    );
    let emitted_small = logs_small.iter().any(|line| line.starts_with("Program data: "));
    assert!(
        !emitted_small,
        "expected NO LargeTransactionFlag event for a $9,999.99 transfer, but one was found in: {logs_small:?}"
    );
    println!("PASS  $9,999.99 transfer succeeded and correctly did NOT emit a LargeTransactionFlag event");
}
