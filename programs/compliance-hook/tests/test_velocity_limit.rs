//! Phase 1b done-test: a transfer under the sender's hourly velocity cap
//! succeeds, and a transfer that would push the running total over the cap
//! reverts. Both go through a real Token-2022 mint with the Transfer Hook
//! extension pointing at this program, so Token-2022 itself invokes our
//! `execute` fallback via CPI — this isn't calling our check function
//! directly.

use {
    anchor_lang::{
        prelude::Pubkey as AnchorPubkey,
        solana_program::instruction::AccountMeta as AnchorAccountMeta,
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_address::Address,
    solana_instruction::{AccountMeta, Instruction},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    spl_token_2022_interface::{
        extension::{transfer_hook, ExtensionType},
        instruction as token_ix,
        state::{Account as TokenAccountState, Mint as TokenMintState},
    },
    std::str::FromStr,
};

fn addr_to_anchor_pubkey(a: Address) -> AnchorPubkey {
    let bytes: [u8; 32] = a.as_ref().try_into().expect("Address is 32 bytes");
    AnchorPubkey::new_from_array(bytes)
}

fn anchor_pubkey_to_addr(p: AnchorPubkey) -> Address {
    Address::from(p.to_bytes())
}

/// Converts an Anchor-built (program_id, accounts, data) instruction into
/// the Address-typed `Instruction` that litesvm/solana-message expect.
fn to_sol_instruction(
    program_id: AnchorPubkey,
    accounts: Vec<AnchorAccountMeta>,
    data: Vec<u8>,
) -> Instruction {
    Instruction {
        program_id: anchor_pubkey_to_addr(program_id),
        accounts: accounts
            .into_iter()
            .map(|m| AccountMeta {
                pubkey: anchor_pubkey_to_addr(m.pubkey),
                is_signer: m.is_signer,
                is_writable: m.is_writable,
            })
            .collect(),
        data,
    }
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Address, signers: &[&Keypair]) {
    let result = try_send(svm, ixs, payer, signers);
    assert!(result.is_ok(), "transaction unexpectedly failed: {:?}", result.err());
}

fn try_send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Address,
    signers: &[&Keypair],
) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(payer), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{e:?}"))
}

#[test]
fn test_velocity_limit() {
    let hook_program_id = addr_to_anchor_pubkey(Address::from(compliance_hook::id().to_bytes()));
    let hook_program_addr = Address::from(compliance_hook::id().to_bytes());
    let token_program_id =
        Address::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/compliance_hook.so"
    ));
    svm.add_program(hook_program_addr, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let client = Keypair::new(); // the sender whose velocity is tracked
    svm.airdrop(&client.pubkey(), 1_000_000_000).unwrap();

    let dest_owner = Keypair::new();
    svm.airdrop(&dest_owner.pubkey(), 1_000_000_000).unwrap();

    let mint = Keypair::new();
    let mint_len =
        ExtensionType::try_calculate_account_len::<TokenMintState>(&[ExtensionType::TransferHook])
            .unwrap();
    let mint_rent = svm.minimum_balance_for_rent_exemption(mint_len);

    let ix_create_mint = anchor_lang::solana_program::system_instruction::create_account(
        &addr_to_anchor_pubkey(payer.pubkey()),
        &addr_to_anchor_pubkey(mint.pubkey()),
        mint_rent,
        mint_len as u64,
        &addr_to_anchor_pubkey(token_program_id),
    );
    let ix_create_mint = to_sol_instruction(
        ix_create_mint.program_id,
        ix_create_mint.accounts,
        ix_create_mint.data,
    );

    let ix_init_hook =
        transfer_hook::instruction::initialize(&token_program_id, &mint.pubkey(), None, Some(hook_program_addr))
            .unwrap();

    let ix_init_mint =
        token_ix::initialize_mint2(&token_program_id, &mint.pubkey(), &payer.pubkey(), None, 2)
            .unwrap();

    send(
        &mut svm,
        &[ix_create_mint, ix_init_hook, ix_init_mint],
        &payer.pubkey(),
        &[&payer, &mint],
    );

    // --- initialize_extra_account_meta_list (our own Anchor instruction) ---
    let (extra_account_meta_list, _bump) = AnchorPubkey::find_program_address(
        &[b"extra-account-metas", mint.pubkey().as_ref()],
        &hook_program_id,
    );
    let ix_init_extra = to_sol_instruction(
        hook_program_id,
        compliance_hook::accounts::InitializeExtraAccountMetaList {
            authority: addr_to_anchor_pubkey(payer.pubkey()),
            mint: addr_to_anchor_pubkey(mint.pubkey()),
            extra_account_meta_list,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        compliance_hook::instruction::InitializeExtraAccountMetaList {}.data(),
    );
    send(&mut svm, &[ix_init_extra], &payer.pubkey(), &[&payer]);

    // --- init_velocity_account for `client`, risk = Medium ($2,000,000/hr) ---
    let (velocity_account, _bump) = AnchorPubkey::find_program_address(
        &[b"velocity", addr_to_anchor_pubkey(client.pubkey()).as_ref()],
        &hook_program_id,
    );
    let ix_init_velocity = to_sol_instruction(
        hook_program_id,
        compliance_hook::accounts::InitVelocityAccount {
            authority: addr_to_anchor_pubkey(payer.pubkey()),
            client: addr_to_anchor_pubkey(client.pubkey()),
            velocity_account,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        compliance_hook::instruction::InitVelocityAccount {
            risk_rating: compliance_hook::RISK_MEDIUM,
        }
        .data(),
    );
    send(&mut svm, &[ix_init_velocity], &payer.pubkey(), &[&payer]);

    // --- source (owner=client) and destination (owner=dest_owner) accounts ---
    let source = Keypair::new();
    let dest = Keypair::new();
    let token_account_len = ExtensionType::try_calculate_account_len::<TokenAccountState>(&[
        ExtensionType::TransferHookAccount,
    ])
    .unwrap();
    let token_account_rent = svm.minimum_balance_for_rent_exemption(token_account_len);

    let mk_create_account = |kp: &Keypair| {
        let ix = anchor_lang::solana_program::system_instruction::create_account(
            &addr_to_anchor_pubkey(payer.pubkey()),
            &addr_to_anchor_pubkey(kp.pubkey()),
            token_account_rent,
            token_account_len as u64,
            &addr_to_anchor_pubkey(token_program_id),
        );
        to_sol_instruction(ix.program_id, ix.accounts, ix.data)
    };

    let ix_create_source = mk_create_account(&source);
    let ix_init_source =
        token_ix::initialize_account3(&token_program_id, &source.pubkey(), &mint.pubkey(), &client.pubkey())
            .unwrap();
    let ix_create_dest = mk_create_account(&dest);
    let ix_init_dest = token_ix::initialize_account3(
        &token_program_id,
        &dest.pubkey(),
        &mint.pubkey(),
        &dest_owner.pubkey(),
    )
    .unwrap();

    send(
        &mut svm,
        &[ix_create_source, ix_init_source, ix_create_dest, ix_init_dest],
        &payer.pubkey(),
        &[&payer, &source, &dest],
    );

    // --- mint $3,000,000.00 (300,000,000 cents) to source ---
    let ix_mint_to = token_ix::mint_to_checked(
        &token_program_id,
        &mint.pubkey(),
        &source.pubkey(),
        &payer.pubkey(),
        &[],
        300_000_000,
        2,
    )
    .unwrap();
    send(&mut svm, &[ix_mint_to], &payer.pubkey(), &[&payer]);

    // Per spl_transfer_hook_interface::offchain's resolution order: resolved
    // extra accounts first, then the hook program itself (so Token-2022 can
    // CPI into it), then the validation/extra-account-meta-list PDA last.
    let extra_accounts = [
        AccountMeta {
            pubkey: anchor_pubkey_to_addr(velocity_account),
            is_signer: false,
            is_writable: true,
        },
        AccountMeta {
            pubkey: hook_program_addr,
            is_signer: false,
            is_writable: false,
        },
        AccountMeta {
            pubkey: anchor_pubkey_to_addr(extra_account_meta_list),
            is_signer: false,
            is_writable: false,
        },
    ];

    // --- Scenario 1: transfer $1,500,000.00 — under the $2,000,000/hr cap ---
    let mut ix_transfer_1 = token_ix::transfer_checked(
        &token_program_id,
        &source.pubkey(),
        &mint.pubkey(),
        &dest.pubkey(),
        &client.pubkey(),
        &[],
        150_000_000,
        2,
    )
    .unwrap();
    ix_transfer_1.accounts.extend_from_slice(&extra_accounts);

    let result_1 = try_send(&mut svm, &[ix_transfer_1], &payer.pubkey(), &[&payer, &client]);
    assert!(
        result_1.is_ok(),
        "expected under-cap transfer ($1,500,000.00) to succeed: {:?}",
        result_1.err()
    );
    println!("PASS  transfer under velocity cap ($1,500,000.00 of $2,000,000.00/hr) succeeded");

    // --- Scenario 2: transfer $1,000,000.00 more — would bring the running
    // total to $2,500,000.00, over the $2,000,000/hr cap — must revert ---
    let mut ix_transfer_2 = token_ix::transfer_checked(
        &token_program_id,
        &source.pubkey(),
        &mint.pubkey(),
        &dest.pubkey(),
        &client.pubkey(),
        &[],
        100_000_000,
        2,
    )
    .unwrap();
    ix_transfer_2.accounts.extend_from_slice(&extra_accounts);

    let result_2 = try_send(&mut svm, &[ix_transfer_2], &payer.pubkey(), &[&payer, &client]);
    assert!(
        result_2.is_err(),
        "expected over-cap transfer to revert, but it succeeded"
    );
    println!(
        "PASS  transfer over velocity cap (would reach $2,500,000.00 of $2,000,000.00/hr) reverted: {}",
        result_2.err().unwrap()
    );
}
