/**
 * Phase 2 (plan-001.md): creates the real Token-2022 mint for this POC —
 * not a throwaway test mint like Phases 0.5/1a-1e's spikes. Configures
 * exactly the three mint-level extensions resolved by Phase 0.5 and built
 * on by Phase 1:
 *   - Default Account State (frozen) — Layer 1 compliance gate.
 *   - Permanent Delegate — bank-controlled compliance recovery/clawback.
 *   - Transfer Hook — points at the real, deployed compliance-hook program
 *     (not a placeholder ID, unlike Phase 0.5's spike).
 * Decimals = 2, per spec-001.md's Token design (USD cents).
 *
 * Deliberately does NOT configure Required Memo (MemoTransfer) here —
 * Phase 0.5 confirmed it's an account-level extension, not mint-level, so
 * it belongs in onboarding (Phase 3), not mint creation. Deliberately does
 * NOT configure PermissionedBurn — spec-001.md's Redeem/burn flow resolved
 * that redemption uses the gateway-program mechanism instead (Approve +
 * a custom program CPI into base Burn), which needs no mint extension.
 *
 * Authorities: per plan-001.md decision #4, mint/freeze/permanent-delegate
 * authority is a dedicated local "bank-ops" keypair (generated once, saved
 * gitignored to backend/keys/bank-ops.json, reused on later runs) — not
 * the developer's own default Solana CLI keypair, which here only pays
 * for and signs the mint account's own creation.
 *
 * Idempotent: if backend/keys/mint-address.json already points at a real
 * mint, reuses it instead of creating a new one — Phase 3+ needs a single,
 * stable mint address to build against, not a fresh one every run.
 */
import crypto from "node:crypto";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  AccountState,
  createInitializeDefaultAccountStateInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMintInstruction,
  getMintLen,
  getMint,
  getDefaultAccountState,
  getPermanentDelegate,
  getTransferHook,
} from "@solana/spl-token";
import {
  getConnection,
  loadLocalKeypair,
  loadOrCreateBankOpsKeypair,
  readPersistedMintAddress,
  persistMintAddress,
  HOOK_PROGRAM_ID,
  DECIMALS,
} from "../src/solana/authorities.js";

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
}

/**
 * Fixed after Phase 5 discovered the gap: pointing a mint at a Transfer
 * Hook program (createInitializeTransferHookInstruction, above) only sets
 * *which* program to invoke — it does not create that program's own
 * extra-account-meta-list PDA (a separate account under the hook program
 * itself, holding the extra accounts Execute needs resolved: velocity
 * account, Instructions sysvar, sanctions registry). Without it, Token-2022
 * can't even locate our program's extra accounts and every transfer fails
 * with "An account required by the instruction is missing" — invisible to
 * `spl-token display`, this script's original done-test, since that only
 * inspects the mint's own extension config, not the hook program's side.
 */
async function ensureExtraAccountMetaList(
  connection: import("@solana/web3.js").Connection,
  payer: Keypair,
  mintPubkey: PublicKey,
): Promise<void> {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mintPubkey.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const existing = await connection.getAccountInfo(pda);
  if (existing) {
    console.log(`Extra-account-meta-list already initialized: ${pda.toBase58()}`);
    return;
  }

  const ix = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mintPubkey, isSigner: false, isWritable: false },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("initialize_extra_account_meta_list"),
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log(`Extra-account-meta-list initialized: ${pda.toBase58()} (tx ${sig})`);
}

async function main() {
  const connection = getConnection();
  const payer = loadLocalKeypair();
  const bankOps = await loadOrCreateBankOpsKeypair(connection);

  console.log(`Payer (fee/rent payer): ${payer.publicKey.toBase58()}`);
  console.log(`Bank-ops authority (mint/freeze/permanent-delegate/transfer-hook): ${bankOps.publicKey.toBase58()}`);
  console.log(`Transfer Hook program (real, deployed): ${HOOK_PROGRAM_ID.toBase58()}`);

  const existingMint = readPersistedMintAddress();
  let mintPubkey;

  if (existingMint) {
    console.log();
    console.log(`Reusing existing mint: ${existingMint.toBase58()}`);
    mintPubkey = existingMint;
  } else {
    const extensions = [
      ExtensionType.DefaultAccountState,
      ExtensionType.PermanentDelegate,
      ExtensionType.TransferHook,
    ];
    const mint = Keypair.generate();
    const mintLen = getMintLen(extensions);
    const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports: mintRent,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeDefaultAccountStateInstruction(
        mint.publicKey,
        AccountState.Frozen,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        bankOps.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeTransferHookInstruction(
        mint.publicKey,
        bankOps.publicKey,
        HOOK_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(
        mint.publicKey,
        DECIMALS,
        bankOps.publicKey, // mint authority
        bankOps.publicKey, // freeze authority
        TOKEN_2022_PROGRAM_ID,
      ),
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint]);
    console.log();
    console.log(`Mint created: ${mint.publicKey.toBase58()}`);
    console.log(`Transaction: ${sig}`);
    persistMintAddress(mint.publicKey);
    console.log(`Saved to backend/keys/mint-address.json`);
    mintPubkey = mint.publicKey;
  }

  console.log();
  await ensureExtraAccountMetaList(connection, payer, mintPubkey);

  // --- Read back every extension from the chain and confirm explicitly —
  // not assumed present because it was requested in the instructions above.
  console.log();
  console.log("--- Read-back verification (on-chain state, not the instructions we sent) ---");
  const mintInfo = await getMint(connection, mintPubkey, "confirmed", TOKEN_2022_PROGRAM_ID);

  const defaultState = getDefaultAccountState(mintInfo);
  console.log(
    `Default Account State: ${defaultState ? AccountState[defaultState.state] : "MISSING"} ${
      defaultState?.state === AccountState.Frozen ? "(correct)" : "(WRONG)"
    }`,
  );

  const permanentDelegate = getPermanentDelegate(mintInfo);
  const permanentDelegateOk = !!permanentDelegate?.delegate?.equals(bankOps.publicKey);
  console.log(
    `Permanent Delegate: ${permanentDelegate?.delegate?.toBase58() ?? "MISSING"} ${
      permanentDelegateOk ? "(matches bank-ops, correct)" : "(WRONG or missing)"
    }`,
  );

  const transferHook = getTransferHook(mintInfo);
  const transferHookOk = !!transferHook?.programId.equals(HOOK_PROGRAM_ID);
  console.log(
    `Transfer Hook program: ${transferHook?.programId.toBase58() ?? "MISSING"} ${
      transferHookOk ? "(matches real deployed compliance-hook, correct)" : "(WRONG or missing — still a placeholder?)"
    }`,
  );

  console.log(`Decimals: ${mintInfo.decimals} ${mintInfo.decimals === DECIMALS ? "(correct)" : "(WRONG)"}`);

  const allCorrect =
    defaultState?.state === AccountState.Frozen &&
    permanentDelegateOk &&
    transferHookOk &&
    mintInfo.decimals === DECIMALS;

  console.log();
  console.log(allCorrect ? "MINT CREATION VERIFIED" : "MINT CREATION FAILED VERIFICATION");
  console.log();
  console.log(`Run this to inspect independently: spl-token display ${mintPubkey.toBase58()} --program-2022`);

  if (!allCorrect) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("MINT CREATION FAILED");
  console.error(err);
  process.exit(1);
});
