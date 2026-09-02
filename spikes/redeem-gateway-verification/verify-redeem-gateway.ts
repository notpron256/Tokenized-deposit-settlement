/**
 * THROWAWAY spike (plan-001.md Phase 0.5 addendum), not part of the real
 * system. Live-tests the burn-gateway co-sign pattern against the deployed
 * `redeem-gateway-spike` Anchor program, before committing to it as
 * spec-001's Redeem/burn architecture in place of the (locally unsupported)
 * PermissionedBurn extension.
 *
 * Proves two things on-chain, not just by reading source:
 *  1. A redeem attempt with only the client's signature genuinely fails.
 *  2. The same redeem attempt with both the client's and the bank compliance
 *     signer's signatures genuinely succeeds, and the burn actually happens.
 *
 * Ordinary Transfer authorization is never touched by this mechanism — the
 * client's ATA owner stays their own single key throughout. That's the
 * property under test, not just the co-sign gate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createApproveInstruction,
  getAccount,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const GATEWAY_PROGRAM_ID = new PublicKey(
  "BjJxEvxGX68pLDTEQSKFLssXEqtjMZWheW8xbCRkBJaa",
);

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

function buildRedeemInstruction(
  client: PublicKey,
  complianceSigner: PublicKey,
  gatewayAuthority: PublicKey,
  mint: PublicKey,
  tokenAccount: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount);
  const data = Buffer.concat([anchorDiscriminator("redeem"), amountBuf]);

  return new TransactionInstruction({
    programId: GATEWAY_PROGRAM_ID,
    keys: [
      { pubkey: client, isSigner: true, isWritable: false },
      { pubkey: complianceSigner, isSigner: true, isWritable: false },
      { pubkey: gatewayAuthority, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadLocalKeypair();
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Gateway program: ${GATEWAY_PROGRAM_ID.toBase58()}`);

  const [gatewayAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("gateway")],
    GATEWAY_PROGRAM_ID,
  );
  console.log(`Gateway PDA (delegate): ${gatewayAuthority.toBase58()}`);

  // --- Set up a plain Token-2022 mint and a funded client ATA ---
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    2,
    Keypair.generate(),
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`Mint: ${mint.toBase58()}`);

  const client = Keypair.generate();
  const complianceSigner = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(client.publicKey, 1_000_000_000),
    "confirmed",
  );

  const clientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    client.publicKey,
    false,
    "confirmed",
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );

  const depositAmount = 100_000n; // $1,000.00 at 2 decimals
  await mintTo(
    connection,
    payer,
    mint,
    clientAta.address,
    payer,
    depositAmount,
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID,
  );
  console.log(`Minted ${depositAmount} to client ATA ${clientAta.address.toBase58()}`);

  // Client approves the gateway PDA as delegate — ATA owner itself stays
  // the client's own single key throughout; this is the step that matters
  // for keeping ordinary Transfer unaffected.
  const redeemAmount = 25_000n; // $250.00
  const approveTx = new Transaction().add(
    createApproveInstruction(
      clientAta.address,
      gatewayAuthority,
      client.publicKey,
      redeemAmount,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );
  await sendAndConfirmTransaction(connection, approveTx, [payer, client]);
  console.log(`Client approved gateway PDA as delegate for ${redeemAmount}`);

  const balanceBefore = (
    await getAccount(connection, clientAta.address, "confirmed", TOKEN_2022_PROGRAM_ID)
  ).amount;
  console.log(`Client ATA balance before: ${balanceBefore}`);

  // --- Test A: redeem with ONLY the client's signature — must fail ---
  console.log();
  console.log("--- Test A: client signature only (compliance signer omitted) ---");
  const redeemIx = buildRedeemInstruction(
    client.publicKey,
    complianceSigner.publicKey,
    gatewayAuthority,
    mint,
    clientAta.address,
    TOKEN_2022_PROGRAM_ID,
    redeemAmount,
  );
  let testAFailedAsExpected = false;
  let testADetail = "";
  try {
    const tx = new Transaction().add(redeemIx);
    // Deliberately sign with only payer (fee payer) + client — NOT
    // complianceSigner, even though the instruction lists it as a required
    // signer.
    await sendAndConfirmTransaction(connection, tx, [payer, client]);
    testADetail = "Transaction succeeded — THIS IS WRONG, co-sign gate did not hold.";
  } catch (err) {
    testAFailedAsExpected = true;
    testADetail = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  console.log(
    `${testAFailedAsExpected ? "PASS" : "FAIL"} — one-signature redeem ${
      testAFailedAsExpected ? "correctly rejected" : "incorrectly succeeded"
    }: ${testADetail}`,
  );

  const balanceAfterA = (
    await getAccount(connection, clientAta.address, "confirmed", TOKEN_2022_PROGRAM_ID)
  ).amount;
  console.log(
    `Client ATA balance after Test A: ${balanceAfterA} (unchanged=${balanceAfterA === balanceBefore})`,
  );

  // --- Test B: redeem with BOTH signatures — must succeed ---
  console.log();
  console.log("--- Test B: client + compliance signer, both present ---");
  let testBSucceeded = false;
  let testBDetail = "";
  try {
    const tx = new Transaction().add(redeemIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [
      payer,
      client,
      complianceSigner,
    ]);
    testBSucceeded = true;
    testBDetail = `signature=${sig}`;
  } catch (err) {
    testBDetail = err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
  console.log(
    `${testBSucceeded ? "PASS" : "FAIL"} — two-signature redeem ${
      testBSucceeded ? "correctly succeeded" : "incorrectly failed"
    }: ${testBDetail}`,
  );

  const balanceAfterB = (
    await getAccount(connection, clientAta.address, "confirmed", TOKEN_2022_PROGRAM_ID)
  ).amount;
  console.log(
    `Client ATA balance after Test B: ${balanceAfterB} (expected=${
      balanceBefore - redeemAmount
    }, burn actually happened=${balanceAfterB === balanceBefore - redeemAmount})`,
  );

  const allPass =
    testAFailedAsExpected &&
    balanceAfterA === balanceBefore &&
    testBSucceeded &&
    balanceAfterB === balanceBefore - redeemAmount;

  console.log();
  console.log(
    allPass
      ? "GATEWAY PATTERN VERIFIED: one signature fails, two signatures succeed, burn confirmed on-chain."
      : "GATEWAY PATTERN VERIFICATION FAILED — see detail above.",
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("GATEWAY PATTERN VERIFICATION FAILED");
  console.error(err);
  process.exit(1);
});
