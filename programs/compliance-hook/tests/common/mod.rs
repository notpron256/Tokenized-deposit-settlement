//! Shared test setup for compliance-hook's litesvm integration tests.
//! Builds a throwaway Token-2022 mint with just the Transfer Hook
//! extension, initializes this program's extra-account-meta-list and a
//! velocity account for a client, and creates funded source/destination
//! token accounts — everything every `execute` scenario test needs before
//! it can exercise a specific check.

use anchor_lang::{
    prelude::Pubkey as AnchorPubkey, solana_program::instruction::AccountMeta as AnchorAccountMeta,
    InstructionData, ToAccountMetas,
};
use litesvm::LiteSVM;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use spl_token_2022_interface::{
    extension::{transfer_hook, ExtensionType},
    instruction as token_ix,
    state::{Account as TokenAccountState, Mint as TokenMintState},
};
use std::str::FromStr;

pub const MEMO_PROGRAM_V3: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

pub fn addr_to_anchor_pubkey(a: Address) -> AnchorPubkey {
    let bytes: [u8; 32] = a.as_ref().try_into().expect("Address is 32 bytes");
    AnchorPubkey::new_from_array(bytes)
}

pub fn anchor_pubkey_to_addr(p: AnchorPubkey) -> Address {
    Address::from(p.to_bytes())
}

/// Converts an Anchor-built (program_id, accounts, data) instruction into
/// the Address-typed `Instruction` that litesvm/solana-message expect.
pub fn to_sol_instruction(
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

pub fn memo_instruction(text: &str) -> Instruction {
    Instruction {
        program_id: Address::from_str(MEMO_PROGRAM_V3).unwrap(),
        accounts: vec![],
        data: text.as_bytes().to_vec(),
    }
}

pub fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Address, signers: &[&Keypair]) {
    let result = try_send(svm, ixs, payer, signers);
    assert!(result.is_ok(), "transaction unexpectedly failed: {:?}", result.err());
}

pub fn try_send(
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

/// Like `send`, but returns the transaction's captured program logs on
/// success — for tests that need to confirm something was actually logged
/// (e.g. an emitted event), not just that the transaction succeeded.
pub fn send_capturing_logs(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Address,
    signers: &[&Keypair],
) -> Vec<String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(payer), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .expect("failed to build transaction");
    let result = svm.send_transaction(tx);
    assert!(result.is_ok(), "transaction unexpectedly failed: {:?}", result.err());
    result.unwrap().logs
}

pub struct TestSetup {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub client: Keypair, // sender whose velocity is tracked
    pub dest_owner: Keypair,
    pub hook_program_id: AnchorPubkey,
    pub hook_program_addr: Address,
    pub token_program_id: Address,
    pub mint: Keypair,
    pub source: Keypair,
    pub dest: Keypair,
    pub extra_account_meta_list: AnchorPubkey,
    pub velocity_account: AnchorPubkey,
    pub sanctions_registry: AnchorPubkey,
}

impl TestSetup {
    /// Accounts to append to a TransferChecked instruction, per
    /// spl_transfer_hook_interface::offchain's resolution order: resolved
    /// extra accounts first (velocity account, then Instructions sysvar,
    /// then the sanctions registry), then the hook program itself, then the
    /// validation/extra-account-meta-list PDA last.
    pub fn extra_transfer_accounts(&self) -> Vec<AccountMeta> {
        vec![
            AccountMeta {
                pubkey: anchor_pubkey_to_addr(self.velocity_account),
                is_signer: false,
                is_writable: true,
            },
            AccountMeta {
                pubkey: Address::from(solana_sdk_ids::sysvar::instructions::ID.to_bytes()),
                is_signer: false,
                is_writable: false,
            },
            AccountMeta {
                pubkey: anchor_pubkey_to_addr(self.sanctions_registry),
                is_signer: false,
                is_writable: false,
            },
            AccountMeta {
                pubkey: self.hook_program_addr,
                is_signer: false,
                is_writable: false,
            },
            AccountMeta {
                pubkey: anchor_pubkey_to_addr(self.extra_account_meta_list),
                is_signer: false,
                is_writable: false,
            },
        ]
    }
}

/// Sets up a mint + hook wiring + a Medium-risk ($2,000,000.00/hr) velocity
/// account for `client`, with $3,000,000.00 already minted to `source`.
pub fn setup(risk_rating: u8) -> TestSetup {
    let hook_program_id = compliance_hook::id();
    let hook_program_addr = anchor_pubkey_to_addr(hook_program_id);
    let token_program_id = Address::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/compliance_hook.so"
    ));
    svm.add_program(hook_program_addr, bytes).unwrap();

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    let client = Keypair::new();
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
    let ix_create_mint =
        to_sol_instruction(ix_create_mint.program_id, ix_create_mint.accounts, ix_create_mint.data);

    let ix_init_hook =
        transfer_hook::instruction::initialize(&token_program_id, &mint.pubkey(), None, Some(hook_program_addr))
            .unwrap();
    let ix_init_mint =
        token_ix::initialize_mint2(&token_program_id, &mint.pubkey(), &payer.pubkey(), None, 2).unwrap();

    send(
        &mut svm,
        &[ix_create_mint, ix_init_hook, ix_init_mint],
        &payer.pubkey(),
        &[&payer, &mint],
    );

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
        compliance_hook::instruction::InitVelocityAccount { risk_rating }.data(),
    );
    send(&mut svm, &[ix_init_velocity], &payer.pubkey(), &[&payer]);

    let (sanctions_registry, _bump) =
        AnchorPubkey::find_program_address(&[b"sanctions-registry"], &hook_program_id);
    let ix_init_sanctions = to_sol_instruction(
        hook_program_id,
        compliance_hook::accounts::InitSanctionsRegistry {
            authority: addr_to_anchor_pubkey(payer.pubkey()),
            sanctions_registry,
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
        compliance_hook::instruction::InitSanctionsRegistry {}.data(),
    );
    send(&mut svm, &[ix_init_sanctions], &payer.pubkey(), &[&payer]);

    let source = Keypair::new();
    let dest = Keypair::new();
    let token_account_len =
        ExtensionType::try_calculate_account_len::<TokenAccountState>(&[ExtensionType::TransferHookAccount])
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
    let ix_init_dest =
        token_ix::initialize_account3(&token_program_id, &dest.pubkey(), &mint.pubkey(), &dest_owner.pubkey())
            .unwrap();

    send(
        &mut svm,
        &[ix_create_source, ix_init_source, ix_create_dest, ix_init_dest],
        &payer.pubkey(),
        &[&payer, &source, &dest],
    );

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

    TestSetup {
        svm,
        payer,
        client,
        dest_owner,
        hook_program_id,
        hook_program_addr,
        token_program_id,
        mint,
        source,
        dest,
        extra_account_meta_list,
        velocity_account,
        sanctions_registry,
    }
}
