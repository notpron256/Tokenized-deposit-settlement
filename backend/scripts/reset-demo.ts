/**
 * Phase 10 (plan-001.md): resets Postgres to a clean, empty-but-ready
 * state for a fresh demo walkthrough — and nothing more.
 *
 * What this wipes: every base table in the `public` schema of whichever
 * database `DATABASE_URL` currently points at (`clients`, `client_keys`,
 * `ledger_balances`, `deposit_events`, `transfer_events`,
 * `redemption_requests`, `clawback_events`, `indexed_transfers`,
 * `reconciliation_breaks` as of this writing — discovered from
 * information_schema at run time, not hardcoded, so a future table is
 * wiped too rather than silently surviving a reset). Schema (table/column
 * definitions) is then re-applied from `src/db/schema.sql` — a no-op given
 * every statement there is already idempotent, run again here only so a
 * reset always leaves the database schema-current.
 *
 * What this does NOT and CANNOT wipe or reset:
 *   - The Token-2022 mint, its extensions, or its on-chain token balances.
 *   - The deployed compliance-hook / redemption-gateway programs.
 *   - The on-chain sanctions registry PDA (including its SyntheticTest
 *     entry, which will point at whatever owner address it pointed at
 *     before this reset ran — see the re-onboarding note below).
 *   - Bank-ops/compliance-signer on-chain balances or authority state.
 *   - Any other network's database — this only ever touches the one
 *     network named by the currently active DATABASE_URL/SOLANA_RPC_URL
 *     pair (see README.md's Networks section and .env.example).
 * "Reset" here means "Postgres reset," never "return to blockchain
 * genesis" — that would require redeploying programs and re-creating the
 * mint from scratch, which this script deliberately does not do.
 *
 * Re-onboarding note: the on-chain sanctions registry's SyntheticTest
 * entry is a snapshot of one specific owner address, captured by
 * `seed-sanctions-registry.ts` at the time it last ran. Once this script
 * wipes `clients`, any previously-onboarded "Sanctioned Test Corp" row is
 * gone; re-onboarding a client with that name after this reset generates
 * a brand-new keypair/owner address that the on-chain registry does NOT
 * yet know about. The sanctions check will not correctly flag the new
 * client until `tsx scripts/seed-sanctions-registry.ts "Sanctioned Test
 * Corp"` is re-run against it — this script does not do that
 * automatically, since it doesn't assume any particular demo client set
 * or naming; re-seed it as part of the walkthrough, not as a silent side
 * effect of reset.
 *
 * Confirmation: prints exactly which tables/rows are about to be wiped on
 * which network/database, then requires typing the database name back
 * (or --yes to skip, e.g. for scripted/CI use) before doing anything
 * destructive — a reset script is exactly the kind of tool a wrong
 * DATABASE_URL turns into an accident.
 *
 * Usage:
 *   npm run reset            # interactive confirmation
 *   npm run reset -- --yes   # skip confirmation (scripted use)
 */
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { networkLabel } = await import("../src/solana/authorities.js");

function databaseNameFromUrl(url: string): string {
  return url.replace(/\/+$/, "").split("/").pop() ?? url;
}

async function main() {
  const skipConfirm = process.argv.includes("--yes");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — check .env.");
    process.exit(1);
  }
  const dbName = databaseNameFromUrl(databaseUrl);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  console.log("=== Reset scope ===");
  console.log(`Network (SOLANA_RPC_URL): ${networkLabel()}`);
  console.log(`Database (DATABASE_URL):  ${databaseUrl}`);
  console.log();

  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );

  if (tables.length === 0) {
    console.log("No tables found in this database — nothing to wipe (schema will still be (re)applied).");
  }

  let totalRows = 0;
  for (const { table_name } of tables) {
    const { rows: countRows } = await client.query(`SELECT COUNT(*)::int AS n FROM "${table_name}"`);
    const n = countRows[0].n as number;
    totalRows += n;
    console.log(`  ${table_name.padEnd(24)} ${n} row(s)`);
  }

  if (tables.some((t) => t.table_name === "clients")) {
    const { rows: clientRows } = await client.query(`SELECT name, status FROM clients ORDER BY created_at`);
    if (clientRows.length > 0) {
      console.log();
      console.log("  Clients about to be wiped:");
      for (const c of clientRows) {
        console.log(`    - ${c.name} (${c.status})`);
      }
    }
  }

  console.log();
  console.log(`Total: ${tables.length} table(s), ${totalRows} row(s) across them, on database "${dbName}".`);
  console.log();
  console.log("On-chain state (mint, deployed programs, sanctions registry) is NOT affected by this script.");
  console.log();

  if (!skipConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Type the database name ("${dbName}") to confirm wiping it, anything else to abort: `,
    );
    rl.close();
    if (answer.trim() !== dbName) {
      console.log("Aborted — no changes made.");
      await client.end();
      process.exit(1);
    }
  }

  console.log();
  console.log("Wiping...");
  if (tables.length > 0) {
    const tableList = tables.map((t) => `"${t.table_name}"`).join(", ");
    await client.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
  }
  console.log("Postgres tables truncated.");

  console.log();
  console.log("Re-applying schema (src/db/schema.sql, idempotent)...");
  const schema = fs.readFileSync(path.resolve(backendRoot, "src/db/schema.sql"), "utf-8");
  await client.query(schema);
  console.log("Schema applied.");

  await client.end();

  console.log();
  console.log("Verifying the mint (npm run setup:mint — idempotent, reuses the existing mint if one exists)...");
  execFileSync("npm", ["run", "setup:mint"], { cwd: backendRoot, stdio: "inherit" });

  console.log();
  console.log("=== Postgres reset complete ===");
  console.log(`Database "${dbName}" (network "${networkLabel()}") is now empty and schema-current.`);
  console.log("NOT reset (by design — see this file's header comment): the mint, deployed programs,");
  console.log("sanctions registry, and bank-ops/compliance-signer on-chain state all carry over as-is.");
  console.log();
  console.log("Next: onboard clients through the app as usual. If your demo relies on a synthetic");
  console.log('sanctioned test client, re-run `tsx scripts/seed-sanctions-registry.ts "<name>"` against');
  console.log("it after onboarding — the on-chain registry still points at the old (now-gone) client's");
  console.log("address until then.");
}

main().catch((err) => {
  console.error("RESET FAILED");
  console.error(err);
  process.exit(1);
});
