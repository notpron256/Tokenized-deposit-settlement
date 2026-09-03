/**
 * Re-verifies Phase 1e's large-transaction flag against the actual
 * persistent `solana-test-validator`, not litesvm — same reasoning as the
 * Phase 1b/1c/1d on-chain scripts. Confirms a $10,000.00 transfer succeeds
 * and emits a "Program data: ..." log line (the LargeTransactionFlag
 * event), and confirms a $9,999.99 transfer succeeds without emitting one.
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
import crypto from "node:crypto";

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

  const [sanctionsRegistry] = PublicKey.findProgramAddressSync(
    [Buffer.from("sanctions-registry")],
    HOOK_PROGRAM_ID,
  );
  // The sanctions registry is a single GLOBAL PDA (seeds don't include the
  // mint), so it's only ever initialized once across this validator's
  // lifetime — unlike the mint/velocity-account/extra-account-meta-list
  // above, which are all fresh per script run. Skip init if it already
  // exists (e.g. from a prior verify-sanctions-registry-onchain.ts run)
  // rather than assuming a clean slate.
  const existingRegistry = await connection.getAccountInfo(sanctionsRegistry);
  if (existingRegistry) {
    console.log(`Sanctions registry already exists on-chain (global singleton): ${sanctionsRegistry.toBase58()}`);
  } else {
    const initSanctionsIx = new TransactionInstruction({
      programId: HOOK_PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: sanctionsRegistry, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: anchorDiscriminator("init_sanctions_registry"),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(initSanctionsIx), [payer]);
    console.log(`Sanctions registry initialized on-chain: ${sanctionsRegistry.toBase58()}`);
  }

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

  // --- Scenario 1: $10,000.00 transfer — must succeed and emit the flag ---
  console.log();
  console.log("--- Scenario 1: transfer of $10,000.00 (at the threshold) ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const memoIx = memoInstruction(
      ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(memoIx, ix), [payer, client]);
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    const eventLog = logs.find((l) => l.startsWith("Program data: "));
    if (eventLog) {
      console.log(`PASS  $10,000.00 transfer succeeded on-chain and emitted a flag: ${sig}`);
      console.log(`      ${eventLog}`);
    } else {
      console.log(`FAIL  $10,000.00 transfer succeeded but no "Program data:" log found. Logs: ${JSON.stringify(logs)}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log(`FAIL  $10,000.00 transfer unexpectedly failed: ${err}`);
    process.exitCode = 1;
  }

  // --- Scenario 2: $9,999.99 transfer — must succeed WITHOUT emitting the flag ---
  console.log();
  console.log("--- Scenario 2: transfer of $9,999.99 (just under the threshold) ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      9_999_99n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const memoIx = memoInstruction(
      ":20:INV4522|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4522",
    );
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(memoIx, ix), [payer, client]);
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    const eventLog = logs.find((l) => l.startsWith("Program data: "));
    if (!eventLog) {
      console.log(`PASS  $9,999.99 transfer succeeded on-chain and correctly did NOT emit a flag: ${sig}`);
    } else {
      console.log(`FAIL  $9,999.99 transfer incorrectly emitted a flag: ${eventLog}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.log(`FAIL  $9,999.99 transfer unexpectedly failed: ${err}`);
    process.exitCode = 1;
  }

  console.log();
  console.log(
    process.exitCode === 1
      ? "LARGE-TRANSACTION FLAG CHECK — REAL VALIDATOR VERIFICATION FAILED"
      : "LARGE-TRANSACTION FLAG CHECK — REAL VALIDATOR VERIFICATION PASSED",
  );
}

main().catch((err) => {
  console.error("LARGE-TRANSACTION FLAG CHECK — REAL VALIDATOR VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
