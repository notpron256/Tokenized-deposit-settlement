/**
 * Phase 5 (plan-001.md) setup: seeds the on-chain SanctionsRegistry PDA
 * with a single SyntheticTest entry pointing at a real, normally-onboarded
 * client's owner address — resolved per the design decision made when
 * Phase 5 started: rather than a hardcoded address that only exists in a
 * script, the "seeded synthetic sanctioned address" is a client onboarded
 * through the ordinary flow (e.g. "Sanctioned Test Corp"), so it's
 * selectable as an ordinary transfer recipient in the Transfer UI and only
 * fails at the sanctions check itself.
 *
 * The registry is a single global PDA (no mint in its seeds — see
 * programs/compliance-hook/src/constants.rs), already initialized on this
 * validator by Phase 1d's on-chain verification script
 * (verify-sanctions-registry-onchain.ts), which used the developer's own
 * default CLI keypair as a convenient throwaway payer/authority for that
 * spike — so that key, not a dedicated `sanctions-sync` authority
 * (plan-001.md decision #4), is this registry's actual on-chain
 * sync_authority today. Phase 7 owns introducing the real sanctions-sync
 * keypair; this script reuses whatever authority is already on-chain
 * rather than pre-empting that.
 *
 * `update_sanctions_registry` is a full replace (see
 * instructions::update_sanctions_registry.rs), so this overwrites whatever
 * was there before — including Phase 1d's leftover ephemeral test entry,
 * which had no lasting meaning anyway.
 *
 * Usage: tsx scripts/seed-sanctions-registry.ts "<client name>"
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { RPC_URL, HOOK_PROGRAM_ID, loadLocalKeypair } from "../src/solana/authorities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

// Dynamic import, not a plain top-level one: db/pool.ts reads
// process.env.DATABASE_URL at module-load time, which a hoisted static
// import would run before dotenv.config() above (same reasoning as
// server.ts's own dynamic route imports).
const { pool } = await import("../src/db/pool.js");

const SANCTIONS_SOURCE_SYNTHETIC_TEST = 1;

function anchorDiscriminator(instructionName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${instructionName}`).digest().subarray(0, 8);
}

function encodeEntries(entries: { address: PublicKey; source: number }[]): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(entries.length);
  const entryBufs = entries.map((e) => Buffer.concat([e.address.toBuffer(), Buffer.from([e.source])]));
  return Buffer.concat([lenBuf, ...entryBufs]);
}

async function main() {
  const clientName = process.argv[2];
  if (!clientName) {
    console.error('Usage: tsx scripts/seed-sanctions-registry.ts "<client name>"');
    process.exit(1);
  }

  const { rows } = await pool.query(`SELECT owner_address FROM clients WHERE name = $1`, [clientName]);
  if (rows.length === 0) {
    console.error(`No client named "${clientName}" — onboard it first via the Onboarding page/API.`);
    process.exit(1);
  }
  const ownerAddress = new PublicKey(rows[0].owner_address);
  console.log(`Client "${clientName}" owner address: ${ownerAddress.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadLocalKeypair();
  console.log(`Registry authority (dev local keypair): ${authority.publicKey.toBase58()}`);

  const [registryPda] = PublicKey.findProgramAddressSync([Buffer.from("sanctions-registry")], HOOK_PROGRAM_ID);
  console.log(`Registry PDA: ${registryPda.toBase58()}`);

  const existing = await connection.getAccountInfo(registryPda);
  if (!existing) {
    console.log("Registry not yet initialized — initializing now.");
    const initIx = new TransactionInstruction({
      programId: HOOK_PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: registryPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: anchorDiscriminator("init_sanctions_registry"),
    });
    await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [authority]);
    console.log("Registry initialized.");
  }

  const updateIx = new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: registryPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      anchorDiscriminator("update_sanctions_registry"),
      encodeEntries([{ address: ownerAddress, source: SANCTIONS_SOURCE_SYNTHETIC_TEST }]),
    ]),
  });
  const signature = await sendAndConfirmTransaction(connection, new Transaction().add(updateIx), [authority]);
  console.log(`Registry updated: 1 entry (SyntheticTest) -> ${ownerAddress.toBase58()}`);
  console.log(`Signature: ${signature}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
