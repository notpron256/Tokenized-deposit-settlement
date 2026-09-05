/**
 * Shared bank authority/config loading, used by every backend script and
 * route that talks to Solana. Extracted from scripts/create-mint.ts so
 * Phase 3+ don't duplicate it.
 *
 * Network-scoped key storage (added when promoting compliance-hook/mint/
 * registry to devnet): SOLANA_RPC_URL determines which of
 * backend/keys/local/ or backend/keys/devnet/ this process reads and
 * writes — a keypair or mint address from one network must never be
 * silently reused as if it were the other's. See .env.example for the
 * full network-scoped variable groups (SOLANA_RPC_URL + DATABASE_URL +
 * keys directory all move together).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
export const HOOK_PROGRAM_ID = new PublicKey(
  "9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z",
);
export const DECIMALS = 2;

/** "devnet" if SOLANA_RPC_URL points at devnet, otherwise "local" — the
 * name of the backend/keys/ subdirectory this process reads/writes. */
export function networkLabel(): "devnet" | "local" {
  return RPC_URL.includes("devnet") ? "devnet" : "local";
}

const KEYS_DIR = path.resolve(__dirname, "../../keys", networkLabel());
const BANK_OPS_KEYPAIR_PATH = path.join(KEYS_DIR, "bank-ops.json");
const MINT_ADDRESS_PATH = path.join(KEYS_DIR, "mint-address.json");

export function getConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

/** The developer's own default Solana CLI keypair — used only as the
 * fee/rent payer, never as a bank authority. Not network-scoped: a
 * keypair file isn't tied to any particular cluster, only its balance is
 * (checked separately per network, e.g. via `solana balance --url ...`). */
export function loadLocalKeypair(): Keypair {
  const keypairPath = path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Loads the persistent bank-ops authority keypair (mint/freeze/permanent-
 * delegate/transfer-hook authority — plan-001.md decision #4) for the
 * current network (backend/keys/<network>/bank-ops.json), generating and
 * saving one on first use so the same authority is reused across runs.
 *
 * bank-ops isn't just a passive authority reference — compliance-hook's
 * `init_velocity_account` (and likely other future instructions) uses it
 * as `payer` for accounts it creates, so it needs its own SOL balance, not
 * just a pubkey. On localhost, a fresh key is auto-airdropped 10 SOL
 * (unlimited local faucet). On devnet, that same 10 SOL request would be
 * rejected or throttled by the real faucet, so a fresh devnet bank-ops key
 * is generated with **no** balance — fund it with a modest, explicit
 * transfer from an already-funded devnet keypair instead (see
 * scripts/promote-to-devnet.ts), not by relying on this function's
 * localhost-only airdrop convenience. */
export async function loadOrCreateBankOpsKeypair(connection?: Connection): Promise<Keypair> {
  if (fs.existsSync(BANK_OPS_KEYPAIR_PATH)) {
    const secret = JSON.parse(fs.readFileSync(BANK_OPS_KEYPAIR_PATH, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const keypair = Keypair.generate();
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(BANK_OPS_KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Generated new ${networkLabel()} bank-ops keypair, saved to ${BANK_OPS_KEYPAIR_PATH}`);

  if (networkLabel() === "local") {
    const conn = connection ?? getConnection();
    const airdropSig = await conn.requestAirdrop(keypair.publicKey, 10_000_000_000); // 10 SOL
    await conn.confirmTransaction(airdropSig, "confirmed");
    console.log(`Airdropped 10 SOL to bank-ops (${keypair.publicKey.toBase58()})`);
  } else {
    console.log(
      `New devnet bank-ops key has zero balance — fund it manually before use (it pays for accounts it creates, e.g. init_velocity_account).`,
    );
  }

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

/** Loads the real mint's address, created by `npm run setup:mint`, for the
 * current network. Throws a clear, actionable error if that hasn't been
 * run yet, rather than failing deep inside some later Solana call. */
export function requireMintAddress(): PublicKey {
  const mint = readPersistedMintAddress();
  if (!mint) {
    throw new Error(
      `No mint found for network "${networkLabel()}" — run `
        + `\`npm run setup:mint\` first (${MINT_ADDRESS_PATH} is missing).`,
    );
  }
  return mint;
}
