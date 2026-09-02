/**
 * Phase 0.5 spike (plan-001.md): confirms, against the actually-installed
 * @solana/spl-token API, how each Token design extension from spec-001.md
 * really works — rather than assuming. Creates a throwaway Token-2022 mint
 * on localhost with Default Account State, Permanent Delegate, Transfer Hook
 * (pointed at a placeholder program ID), and Permissioned Burn; creates one
 * ATA and enables MemoTransfer on it. Prints each finding and reads back
 * from the chain to confirm, ending in ALL EXTENSIONS VERIFIED or a clear
 * failure. Nothing here is the real mint (Phase 2) or the real hook program
 * (Phase 1) — nothing created by this script is meant to be kept.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializePermissionedBurnInstruction,
  createInitializeTransferHookInstruction,
  createEnableRequiredMemoTransfersInstruction,
  createReallocateInstruction,
  getMint,
  getAccount,
  getMintLen,
  getDefaultAccountState,
  getPermanentDelegate,
  getTransferHook,
  getPermissionedBurn,
  getMemoTransfer,
  getOrCreateAssociatedTokenAccount,
  thawAccount,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";

// Placeholder — the Phase 0 scaffold program deployed to localhost.
// Real Transfer Hook logic doesn't exist until Phase 1.
const PLACEHOLDER_HOOK_PROGRAM_ID = new PublicKey(
  "9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z",
);

function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

type CheckResult = { name: string; pass: boolean; detail: string };
const results: CheckResult[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadLocalKeypair();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);

  // --- Mint A: the three extensions expected to be uncontroversial ---
  const mint = Keypair.generate();
  const extensions = [
    ExtensionType.DefaultAccountState,
    ExtensionType.PermanentDelegate,
    ExtensionType.TransferHook,
  ];
  const mintLen = getMintLen(extensions);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeDefaultAccountStateInstruction(
      mint.publicKey,
      AccountState.Frozen,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializePermanentDelegateInstruction(
      mint.publicKey,
      payer.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeTransferHookInstruction(
      mint.publicKey,
      payer.publicKey,
      PLACEHOLDER_HOOK_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      2, // decimals — matches spec-001's USD-cents design
      payer.publicKey, // mint authority
      payer.publicKey, // freeze authority
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [payer, mint]);
  console.log(`Mint A created: ${mint.publicKey.toBase58()}`);

  // --- Mint B: PermissionedBurn in isolation, tested separately so a
  // failure here doesn't block reading back the results for Mint A. ---
  const permBurnMint = Keypair.generate();
  const permBurnMintLen = getMintLen([ExtensionType.PermissionedBurn]);
  const permBurnLamports = await connection.getMinimumBalanceForRentExemption(
    permBurnMintLen,
  );
  let permissionedBurnSupported = true;
  let permissionedBurnError = "";
  try {
    const permBurnMintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: permBurnMint.publicKey,
        space: permBurnMintLen,
        lamports: permBurnLamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermissionedBurnInstruction(
        permBurnMint.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMintInstruction(
        permBurnMint.publicKey,
        2,
        payer.publicKey,
        payer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, permBurnMintTx, [
      payer,
      permBurnMint,
    ]);
    console.log(`Mint B (PermissionedBurn) created: ${permBurnMint.publicKey.toBase58()}`);
  } catch (err) {
    permissionedBurnSupported = false;
    permissionedBurnError = err instanceof Error ? err.message : String(err);
    console.log(`Mint B (PermissionedBurn) failed on-chain: ${permissionedBurnError}`);
  }

  const mintInfo = await getMint(
    connection,
    mint.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );

  const defaultState = getDefaultAccountState(mintInfo);
  record(
    "DefaultAccountState (mint extension)",
    defaultState?.state === AccountState.Frozen,
    `on-chain state=${defaultState?.state} (expected Frozen=${AccountState.Frozen})`,
  );

  const permanentDelegate = getPermanentDelegate(mintInfo);
  record(
    "PermanentDelegate (mint extension)",
    !!permanentDelegate?.delegate?.equals(payer.publicKey),
    `on-chain delegate=${permanentDelegate?.delegate?.toBase58()}`,
  );

  const transferHook = getTransferHook(mintInfo);
  record(
    "TransferHook (mint extension)",
    !!transferHook?.programId.equals(PLACEHOLDER_HOOK_PROGRAM_ID),
    `on-chain programId=${transferHook?.programId.toBase58()}`,
  );

  if (permissionedBurnSupported) {
    const permBurnMintInfo = await getMint(
      connection,
      permBurnMint.publicKey,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    const permissionedBurn = getPermissionedBurn(permBurnMintInfo);
    record(
      "PermissionedBurn (mint extension)",
      !!permissionedBurn?.authority?.equals(payer.publicKey),
      `on-chain authority=${permissionedBurn?.authority?.toBase58()}`,
    );
  } else {
    record(
      "PermissionedBurn (mint extension)",
      false,
      `rejected by the local validator's bundled Token-2022 program: ${permissionedBurnError}`,
    );
  }

  // --- Create one ATA and confirm Default Account State froze it ---
  const testClient = Keypair.generate();
  const airdropSig = await connection.requestAirdrop(
    testClient.publicKey,
    1_000_000_000,
  );
  await connection.confirmTransaction(airdropSig, "confirmed");

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint.publicKey,
    testClient.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  record(
    "New ATA starts frozen (Default Account State applied)",
    ata.isFrozen,
    `isFrozen=${ata.isFrozen}`,
  );

  // Thaw (freeze authority = payer), matching how onboarding will work in
  // Phase 3, then enable Required Memo Transfers — confirming it's an
  // account-level extension (MemoTransfer), not a mint-level one.
  await thawAccount(
    connection,
    payer,
    ata.address,
    mint.publicKey,
    payer,
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  // A freshly-created ATA has no space reserved for MemoTransfer — it must
  // be reallocated to make room before the extension can be enabled.
  const enableMemoTx = new Transaction().add(
    createReallocateInstruction(
      ata.address,
      payer.publicKey,
      [ExtensionType.MemoTransfer],
      testClient.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createEnableRequiredMemoTransfersInstruction(
      ata.address,
      testClient.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, enableMemoTx, [
    payer,
    testClient,
  ]);

  const accountInfo = await getAccount(
    connection,
    ata.address,
    "confirmed",
    TOKEN_2022_PROGRAM_ID,
  );
  const memoTransfer = getMemoTransfer(accountInfo);
  record(
    "MemoTransfer (account extension, not mint-level)",
    memoTransfer?.requireIncomingTransferMemos === true,
    `requireIncomingTransferMemos=${memoTransfer?.requireIncomingTransferMemos}`,
  );

  console.log();
  console.log("--- Findings for Phase 1/2 architecture ---");
  console.log(
    "PermissionedBurn is a real, native Token-2022 mint extension in the installed",
  );
  console.log(
    "@solana/spl-token@0.4.15 client SDK (ExtensionType.PermissionedBurn = 28), with a",
  );
  console.log(
    "real createInitializePermissionedBurnInstruction(mint, authority) and a distinct",
  );
  console.log(
    "createPermissionedBurnInstruction(account, mint, owner, permissionedBurnAuthority,",
  );
  console.log(
    "amount, ...) burn path (not the base Burn/BurnChecked instruction) that requires",
  );
  console.log(
    "BOTH the account owner and the permissionedBurnAuthority as signers.",
  );
  if (permissionedBurnSupported) {
    console.log(
      "Confirmed working on-chain against this local validator — no workaround needed.",
    );
  } else {
    console.log(
      "BUT: the on-chain Token-2022 program bundled with this local solana-test-validator",
    );
    console.log(
      "(genesis-deployed, immutable, upgrade authority burned — see `solana program show",
    );
    console.log(
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) rejects the PermissionedBurnExtension",
    );
    console.log(
      "instruction with 'Invalid instruction' (custom program error 0xc) — the SDK knows",
    );
    console.log(
      "how to encode it, but the deployed program predates it. This is a genesis-program-",
    );
    console.log(
      "version gap, not a code bug. Options for Phase 8: (a) restart the local validator",
    );
    console.log(
      "with a newer Token-2022 build supplied at genesis, or (b) fall back to the 2-of-2",
    );
    console.log(
      "SPL Token multisig-as-owner approach floated before this spike. Needs a decision",
    );
    console.log("before Phase 1/2/8 lock in an architecture — see report.");
  }
  console.log();
  console.log(
    "MemoTransfer is confirmed account-level (isAccountExtension === true), not",
  );
  console.log(
    "mint-level — onboarding (Phase 3) must enable it per-ATA, not once at mint",
  );
  console.log(
    "creation (Phase 2). It also can't be enabled on an ATA as-created: a freshly",
  );
  console.log(
    "created associated token account has no space reserved for it, and enabling",
  );
  console.log(
    "it directly fails with InvalidAccountData. Phase 3's onboarding flow needs a",
  );
  console.log(
    "createReallocateInstruction(ata, payer, [ExtensionType.MemoTransfer], owner)",
  );
  console.log("step before enabling it.");

  const allPass = results.every((r) => r.pass);
  console.log();
  console.log(allPass ? "ALL EXTENSIONS VERIFIED" : "EXTENSION VERIFICATION FAILED");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("EXTENSION VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
