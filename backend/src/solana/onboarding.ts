/**
 * Phase 3 (plan-001.md): the on-chain half of onboarding. Generates a new
 * client keypair (spec-001.md's client wallet model: the backend custodies
 * it, a deliberate, named scope decision), creates their ATA (created
 * frozen, per Default Account State), thaws it, enables Required Memo
 * (MemoTransfer — an account-level extension, per Phase 0.5's finding, so
 * it's done here at onboarding, not at mint creation), and initializes
 * their velocity-tracking account on the compliance-hook program with
 * their assigned risk rating.
 *
 * Only sends at Solana's "confirmed" commitment — the caller
 * (routes/onboarding.ts) is responsible for waiting for "finalized" before
 * treating the client as settled (spec-001.md, Technical approach); this
 * function's job stops at getting a confirmed signature.
 */
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  createAssociatedTokenAccountInstruction,
  createThawAccountInstruction,
  createReallocateInstruction,
  createEnableRequiredMemoTransfersInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { HOOK_PROGRAM_ID } from "./authorities.js";

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${instructionName}`)
    .digest()
    .subarray(0, 8);
}

export interface OnboardResult {
  client: Keypair;
  ataAddress: PublicKey;
  velocityAccount: PublicKey;
  signature: string;
  tx: Transaction;
}

export async function onboardClientOnChain(
  connection: Connection,
  payer: Keypair,
  bankOps: Keypair,
  mint: PublicKey,
  riskRating: number,
): Promise<OnboardResult> {
  const client = Keypair.generate();

  const ataAddress = getAssociatedTokenAddressSync(
    mint,
    client.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const [velocityAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("velocity"), client.publicKey.toBuffer()],
    HOOK_PROGRAM_ID,
  );

  const initVelocityIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: bankOps.publicKey, isSigner: true, isWritable: true },
      { pubkey: client.publicKey, isSigner: false, isWritable: false },
      { pubkey: velocityAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator("init_velocity_account"), Buffer.from([riskRating])]),
  });

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ataAddress,
      client.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createThawAccountInstruction(ataAddress, mint, bankOps.publicKey, [], TOKEN_2022_PROGRAM_ID),
    createReallocateInstruction(
      ataAddress,
      payer.publicKey,
      [ExtensionType.MemoTransfer],
      client.publicKey,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createEnableRequiredMemoTransfersInstruction(ataAddress, client.publicKey, [], TOKEN_2022_PROGRAM_ID),
    initVelocityIx,
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [payer, bankOps, client], {
    commitment: "confirmed",
  });

  return { client, ataAddress, velocityAccount, signature, tx };
}
