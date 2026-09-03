/**
 * Applies backend/src/db/schema.sql against DATABASE_URL. Every statement
 * in schema.sql uses CREATE TABLE IF NOT EXISTS, so this is safe to re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const schemaPath = path.resolve(__dirname, "../src/db/schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`Connected: ${process.env.DATABASE_URL}`);

  await client.query(schema);
  console.log("Schema applied.");

  const { rows } = await client.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  console.log("Tables:", rows.map((r) => r.table_name).join(", "));

  await client.end();
}

main().catch((err) => {
  console.error("MIGRATION FAILED");
  console.error(err);
  process.exit(1);
});
