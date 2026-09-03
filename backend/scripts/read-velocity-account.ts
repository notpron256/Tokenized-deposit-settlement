/**
 * Reads a client's VelocityAccount PDA directly off the real persistent
 * solana-test-validator and decodes it by hand (no Anchor IDL client) —
 * an independent, on-chain check that the risk_rating recorded at
 * onboarding (Phase 3) actually matches what Postgres/the UI report.
 *
 * Usage:
 *   tsx scripts/read-velocity-account.ts <client owner pubkey>
 *
 * The owner pubkey is the client's own wallet address (clients.owner_address
 * in Postgres) — the PDA is derived from it with seeds ["velocity", owner],
 * matching programs/compliance-hook/src/instructions/init_velocity_account.rs
 * and backend/src/solana/onboarding.ts.
 */
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "http://localhost:8899";
const HOOK_PROGRAM_ID = new PublicKey("9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z");
const RISK_LABELS = ["low", "medium", "high"];

async function main() {
  const ownerArg = process.argv[2];
  if (!ownerArg) {
    console.error("Usage: tsx scripts/read-velocity-account.ts <client owner pubkey>");
    process.exit(1);
  }
  const owner = new PublicKey(ownerArg);

  const [velocityAccount, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("velocity"), owner.toBuffer()],
    HOOK_PROGRAM_ID,
  );
  console.log(`Owner:            ${owner.toBase58()}`);
  console.log(`Velocity PDA:     ${velocityAccount.toBase58()} (bump ${bump})`);

  const connection = new Connection(RPC_URL, "confirmed");
  const info = await connection.getAccountInfo(velocityAccount);
  if (!info) {
    console.error("Account not found on-chain — client may not be onboarded, or wrong RPC/owner.");
    process.exit(1);
  }

  // VelocityAccount layout (programs/compliance-hook/src/state.rs):
  // [0..8) discriminator, [8..40) client pubkey, [40] risk_rating (u8),
  // [41..49) running_total (u64 LE), [49..57) window_start (i64 LE).
  const data = info.data;
  const client = new PublicKey(data.subarray(8, 40));
  const riskRating = data.readUInt8(40);
  const runningTotalCents = data.readBigUInt64LE(41);
  const windowStart = data.readBigInt64LE(49);

  console.log();
  console.log("Decoded on-chain VelocityAccount:");
  console.log(`  client:          ${client.toBase58()}`);
  console.log(`  risk_rating:     ${riskRating} (${RISK_LABELS[riskRating] ?? "unknown"})`);
  console.log(`  running_total:   ${(Number(runningTotalCents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`);
  console.log(`  window_start:    ${windowStart === 0n ? "0 (unset)" : new Date(Number(windowStart) * 1000).toISOString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
