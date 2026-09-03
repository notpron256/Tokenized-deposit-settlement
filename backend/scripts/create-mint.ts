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
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
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

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const HOOK_PROGRAM_ID = new PublicKey(
  "9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z",
);
const DECIMALS = 2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, "..", "keys");
const BANK_OPS_KEYPAIR_PATH = path.join(KEYS_DIR, "bank-ops.json");

function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Loads the persistent bank-ops authority keypair, generating and saving
 * one on first run so the same authority is reused across script runs —
 * not a fresh throwaway key every time. */
function loadOrCreateBankOpsKeypair(): Keypair {
  if (fs.existsSync(BANK_OPS_KEYPAIR_PATH)) {
    const secret = JSON.parse(fs.readFileSync(BANK_OPS_KEYPAIR_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(BANK_OPS_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Generated new bank-ops keypair, saved to ${BANK_OPS_KEYPAIR_PATH}`);
  return keypair;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadLocalKeypair();
  const bankOps = loadOrCreateBankOpsKeypair();

  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer (fee/rent payer): ${payer.publicKey.toBase58()}`);
  console.log(`Bank-ops authority (mint/freeze/permanent-delegate/transfer-hook): ${bankOps.publicKey.toBase58()}`);
  console.log(`Transfer Hook program (real, deployed): ${HOOK_PROGRAM_ID.toBase58()}`);

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

  // --- Read back every extension from the chain and confirm explicitly —
  // not assumed present because it was requested in the instructions above.
  console.log();
  console.log("--- Read-back verification (on-chain state, not the instructions we sent) ---");
  const mintInfo = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);

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
  console.log(`Run this to inspect independently: spl-token display ${mint.publicKey.toBase58()} --program-2022`);

  if (!allCorrect) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("MINT CREATION FAILED");
  console.error(err);
  process.exit(1);
});
