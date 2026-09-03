/**
 * Re-verifies Phase 1b's velocity-limit check against the actual persistent
 * `solana-test-validator` this whole build runs against — not litesvm.
 * `anchor test` (plan-001.md Phase 1b's stated done-test) runs against an
 * ephemeral in-process litesvm environment; this script exercises the same
 * two scenarios (transfer under cap succeeds, transfer over cap reverts)
 * against the real, currently-deployed compliance-hook program on localhost,
 * requested as additional confirmation before committing Phase 1b.
 *
 * Nothing here is the real mint (Phase 2) or onboarding flow (Phase 3) —
 * it's a throwaway mint/accounts setup, same spirit as the Phase 0.5 spike.
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
const RISK_MEDIUM = 1; // matches compliance-hook's RISK_MEDIUM constant; cap = $2,000,000.00/hr

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

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadLocalKeypair();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`compliance-hook program: ${HOOK_PROGRAM_ID.toBase58()}`);

  // --- mint with just the Transfer Hook extension (minimal, matching the
  // Phase 1b Rust test's scope — no other extensions needed for this check) ---
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

  // --- our own initialize_extra_account_meta_list instruction ---
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

  // --- init_velocity_account for the client, risk = Medium ($2,000,000/hr) ---
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
      Buffer.from([RISK_MEDIUM]),
    ]),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(initVelocityIx), [payer]);
  console.log(`Velocity account initialized on-chain: ${velocityAccount.toBase58()} (risk=Medium, cap=$2,000,000.00/hr)`);

  // --- source (owner=client) and destination token accounts ---
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
    300_000_000n, [], undefined, TOKEN_2022_PROGRAM_ID,
  );
  console.log(`Minted $3,000,000.00 to source ATA ${sourceAta.address.toBase58()}`);

  // --- Scenario 1: transfer $1,500,000.00 — under the $2,000,000/hr cap ---
  console.log();
  console.log("--- Scenario 1: transfer $1,500,000.00 (under $2,000,000.00/hr cap) ---");
  try {
    const ix1 = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      150_000_000n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const sig1 = await sendAndConfirmTransaction(connection, new Transaction().add(ix1), [payer, client]);
    console.log(`PASS  under-cap transfer succeeded on-chain: ${sig1}`);
  } catch (err) {
    console.log(`FAIL  under-cap transfer unexpectedly failed: ${err}`);
    process.exitCode = 1;
  }

  // --- Scenario 2: transfer $1,000,000.00 more — would reach $2,500,000.00,
  // over the $2,000,000/hr cap — must revert ---
  console.log();
  console.log("--- Scenario 2: transfer $1,000,000.00 more (would reach $2,500,000.00, over cap) ---");
  try {
    const ix2 = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      100_000_000n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(ix2), [payer, client]);
    console.log("FAIL  over-cap transfer incorrectly succeeded");
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`PASS  over-cap transfer correctly reverted on-chain: ${message.split("\n")[0]}`);
  }

  console.log();
  console.log(
    process.exitCode === 1
      ? "VELOCITY LIMIT CHECK — REAL VALIDATOR VERIFICATION FAILED"
      : "VELOCITY LIMIT CHECK — REAL VALIDATOR VERIFICATION PASSED",
  );
}

main().catch((err) => {
  console.error("VELOCITY LIMIT CHECK — REAL VALIDATOR VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
