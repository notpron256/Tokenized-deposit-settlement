/**
 * Re-verifies Phase 1d's sanctions registry check against the actual
 * persistent `solana-test-validator`, not litesvm — same reasoning as the
 * Phase 1b/1c on-chain scripts. Seeds the registry with one SyntheticTest
 * entry, confirms a transfer to that party reverts, and confirms an
 * unrelated transfer still succeeds.
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
const SANCTIONS_SOURCE_SYNTHETIC_TEST = 1;

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

// Borsh-encodes Vec<{ address: Pubkey, source: u8 }> the same way Anchor's
// IDL client would, for the update_sanctions_registry instruction arg.
function encodeSanctionsEntries(
  entries: { address: PublicKey; source: number }[],
): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(entries.length, 0);
  const body = Buffer.concat(
    entries.map((e) => Buffer.concat([e.address.toBuffer(), Buffer.from([e.source])])),
  );
  return Buffer.concat([len, body]);
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

  // --- Seed the registry with destOwner as a SyntheticTest entry ---
  const updateSanctionsIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: sanctionsRegistry, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDiscriminator("update_sanctions_registry"),
      encodeSanctionsEntries([
        { address: destOwner.publicKey, source: SANCTIONS_SOURCE_SYNTHETIC_TEST },
      ]),
    ]),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(updateSanctionsIx), [payer]);
  console.log(`Sanctions registry seeded with SyntheticTest entry: ${destOwner.publicKey.toBase58()}`);

  // --- Scenario 1: transfer to the sanctioned destination — must revert ---
  console.log();
  console.log("--- Scenario 1: transfer to sanctioned (SyntheticTest) destination ---");
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, destAta.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const memoIx = memoInstruction(
      ":20:INV4521|:50K:Acme Corp Treasury|:59:Beta LLC Operating|:70:Invoice #4521",
    );
    await sendAndConfirmTransaction(connection, new Transaction().add(memoIx, ix), [payer, client]);
    console.log("FAIL  transfer to sanctioned destination incorrectly succeeded");
    process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`PASS  transfer to sanctioned destination correctly reverted on-chain: ${message.split("\n")[0]}`);
  }

  // --- Scenario 2: transfer to an unrelated, non-sanctioned destination — must succeed ---
  console.log();
  console.log("--- Scenario 2: transfer to unrelated, non-sanctioned destination ---");
  const dest2Owner = Keypair.generate();
  const dest2Ata = await getOrCreateAssociatedTokenAccount(
    connection, payer, mint.publicKey, dest2Owner.publicKey,
    false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );
  try {
    const ix = await createTransferCheckedWithTransferHookInstruction(
      connection, sourceAta.address, mint.publicKey, dest2Ata.address, client.publicKey,
      10_000_00n, 2, [], "confirmed", TOKEN_2022_PROGRAM_ID,
    );
    const memoIx = memoInstruction(
      ":20:INV4522|:50K:Acme Corp Treasury|:59:Gamma Inc Operating|:70:Invoice #4522",
    );
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(memoIx, ix), [payer, client]);
    console.log(`PASS  transfer to unrelated destination succeeded on-chain: ${sig}`);
  } catch (err) {
    console.log(`FAIL  transfer to unrelated destination unexpectedly failed: ${err}`);
    process.exitCode = 1;
  }

  console.log();
  console.log(
    process.exitCode === 1
      ? "SANCTIONS REGISTRY CHECK — REAL VALIDATOR VERIFICATION FAILED"
      : "SANCTIONS REGISTRY CHECK — REAL VALIDATOR VERIFICATION PASSED",
  );
}

main().catch((err) => {
  console.error("SANCTIONS REGISTRY CHECK — REAL VALIDATOR VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
