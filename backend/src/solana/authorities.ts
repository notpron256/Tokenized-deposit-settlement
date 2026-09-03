/**
 * Shared bank authority/config loading, used by every backend script and
 * route that talks to Solana. Extracted from scripts/create-mint.ts so
 * Phase 3+ don't duplicate it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.resolve(__dirname, "../../keys");
const BANK_OPS_KEYPAIR_PATH = path.join(KEYS_DIR, "bank-ops.json");
const MINT_ADDRESS_PATH = path.join(KEYS_DIR, "mint-address.json");

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
export const HOOK_PROGRAM_ID = new PublicKey(
  "9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z",
);
export const DECIMALS = 2;

export function getConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

/** The developer's own default Solana CLI keypair — used only as the
 * fee/rent payer, never as a bank authority. */
export function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Loads the persistent bank-ops authority keypair (mint/freeze/permanent-
 * delegate/transfer-hook authority — plan-001.md decision #4), generating
 * and saving one on first use so the same authority is reused across runs.
 *
 * bank-ops isn't just a passive authority reference — compliance-hook's
 * `init_velocity_account` (and likely other future instructions) uses it
 * as `payer` for accounts it creates, so it needs its own SOL balance, not
 * just a pubkey. Airdropped once on first generation (localhost only,
 * unlimited faucet) rather than assumed funded. */
export async function loadOrCreateBankOpsKeypair(connection?: Connection): Promise<Keypair> {
  if (fs.existsSync(BANK_OPS_KEYPAIR_PATH)) {
    const secret = JSON.parse(fs.readFileSync(BANK_OPS_KEYPAIR_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(BANK_OPS_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Generated new bank-ops keypair, saved to ${BANK_OPS_KEYPAIR_PATH}`);

  const conn = connection ?? getConnection();
  const airdropSig = await conn.requestAirdrop(keypair.publicKey, 10_000_000_000); // 10 SOL
  await conn.confirmTransaction(airdropSig, "confirmed");
  console.log(`Airdropped 10 SOL to bank-ops (${keypair.publicKey.toBase58()})`);

  return keypair;
}

export function readPersistedMintAddress(): PublicKey | null {
  if (!fs.existsSync(MINT_ADDRESS_PATH)) return null;
  const { mint } = JSON.parse(fs.readFileSync(MINT_ADDRESS_PATH, "utf-8"));
  return new PublicKey(mint);
}

export function persistMintAddress(mint: PublicKey): void {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(MINT_ADDRESS_PATH, JSON.stringify({ mint: mint.toBase58() }, null, 2));
}

/** Loads the real mint's address, created by `npm run setup:mint`. Throws
 * a clear, actionable error if that hasn't been run yet, rather than
 * failing deep inside some later Solana call. */
export function requireMintAddress(): PublicKey {
  const mint = readPersistedMintAddress();
  if (!mint) {
    throw new Error(
      "No mint found — run `npm run setup:mint` first (backend/keys/mint-address.json is missing).",
    );
  }
  return mint;
}
