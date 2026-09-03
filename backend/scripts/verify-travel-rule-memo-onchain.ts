/**
 * Re-verifies Phase 1c's Travel Rule memo check against the actual
 * persistent `solana-test-validator`, not litesvm — same reasoning as
 * verify-velocity-limit-onchain.ts for Phase 1b. `anchor test` runs against
 * an ephemeral in-process litesvm environment; this script exercises the
 * same four scenarios (transfer with no memo reverts; transfer with a
 * well-formed memo succeeds; transfer with a memo missing a required
 * MT103 tag reverts; transfer with an empty tagged field reverts) against
 * the real, currently-deployed compliance-hook program on localhost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection,
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
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createTransferCheckedWithTransferHookInstruction,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const HOOK_PROGRAM_ID = new PublicKey(
  "9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z",
);
const MEMO_PROGRAM_V3 = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const RISK_LOW = 0;

function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${instructionName}`)
    .digest()
    .subarray(0, 8);
}

function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_V3,
    keys: [],
    data: Buffer.from(text, "utf-8"),
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadLocalKeypair();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`compliance-hook program: ${HOOK_PROGRAM_ID.toBase58()}`);

  const mint = Keypair.generate();
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  const mintRent = await connection.getMinimumBalanceForRentExemption(mintLen);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports: mintRent,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(
      mint.publicKey,
      payer.publicKey,
      HOOK_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      2,
      payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, createMintTx, [payer, mint]);
  console.log(`Mint created on-chain: ${mint.publicKey.toBase58()}`);

  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const initExtraIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: extraAccountMetaList, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("initialize_extra_account_meta_list"),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(initExtraIx), [payer]);
  console.log(`extra-account-meta-list initialized on-chain: ${extraAccountMetaList.toBase58()}`);

  const client = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(client.publicKey, 1_000_000_000),
    "confirmed",
  );

  const [velocityAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("velocity"), client.publicKey.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  const initVelocityIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: client.publicKey, isSigner: false, isWritable: false },
      { pubkey: velocityAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("init_velocity_account"),
      Buffer.from([RISK_LOW]),
    ]),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(initVelocityIx), [payer]);
  console.log(`Velocity account initialized on-chain: ${velocityAccount.toBase58()} (risk=Low)`);

  const destOwner = Keypair.generate();
  const sourceAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint.publicKey, client.publicKey,
    false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );
  const destAta = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint.publicKey, destOwner.publicKey,
    false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(
    connection, payer, mint.publicKey, sourceAta.address, payer,
    100_000_00n, [], undefined, TOKEN_2022_PROGRAM_ID,
  );
  console.log(`Minted $100,000.00 to source ATA ${sourceAta.address.toBase58()}`);

  // --- Scenario 1: transfer with no preceding memo — must revert ---
  console.log();
  console.log("--- Scenario 1: transfer with no Travel Rule memo ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer, client]);
    console.log("FAIL  transfer with no memo incorrectly succeeded");
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`PASS  transfer with no memo correctly reverted on-chain: ${message.split("\n")[0]}`);
  }

  // --- Scenario 2: transfer preceded by a well-formed Travel Rule memo — must succeed ---
  console.log();
  console.log("--- Scenario 2: transfer with well-formed Travel Rule memo ---");
  try {
    const transferIx = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const memoIx = memoInstruction(
      ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(memoIx, transferIx),
      [payer, client],
    );
    console.log(`PASS  transfer with well-formed memo succeeded on-chain: ${sig}`);
  } catch (err) {
    console.log(`FAIL  transfer with well-formed memo unexpectedly failed: ${err}`);
    process.exitCode = 1;
  }

  // --- Scenario 3: memo present but missing the :50K: tag entirely — must revert ---
  console.log();
  console.log("--- Scenario 3: transfer with malformed memo (missing :50K: tag) ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const badMemoIx = memoInstruction(
      ":20:INV4521|Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(badMemoIx, ix), [payer, client]);
    console.log("FAIL  transfer with malformed memo (missing :50K: tag) incorrectly succeeded");
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`PASS  transfer with malformed memo (missing :50K: tag) correctly reverted on-chain: ${message.split("\n")[0]}`);
  }

  // --- Scenario 4: all four tags present, but :59: field left empty — must revert ---
  console.log();
  console.log("--- Scenario 4: transfer with empty :59: (beneficiary) field ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const emptyFieldMemoIx = memoInstruction(
      ":20:INV4521|:50K:Acme Corp Treasury|:59:|:70:Invoice #4521",
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(emptyFieldMemoIx, ix), [payer, client]);
    console.log("FAIL  transfer with empty :59: field incorrectly succeeded");
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`PASS  transfer with empty :59: field correctly reverted on-chain: ${message.split("\n")[0]}`);
  }

  console.log();
  console.log(
    process.exitCode === 1
      ? "TRAVEL RULE MEMO CHECK — REAL VALIDATOR VERIFICATION FAILED"
      : "TRAVEL RULE MEMO CHECK — REAL VALIDATOR VERIFICATION PASSED",
  );
}

main().catch((err) => {
  console.error("TRAVEL RULE MEMO CHECK — REAL VALIDATOR VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
