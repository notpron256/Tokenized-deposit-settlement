/**
 * Phase 9 (plan-001.md): the deliberate break-injection script named in
 * this phase's done-test. Manually corrupts one client's Postgres
 * `tokenized_cents` directly -- no on-chain interaction at all -- to
 * simulate real-world ledger drift (a bug, a manual data-entry error, a
 * partial failure some other flow didn't catch), independent of any of
 * this app's own value-moving flows. Never touches `cash_balance_cents`,
 * matching how every real drift-inducing action in this app (clawback,
 * redemption) only ever moves the tokenized side.
 *
 * Usage: tsx scripts/inject-break.ts "<client name>" <delta_cents>
 *   e.g. tsx scripts/inject-break.ts "Acme Corp Treasury" 100000
 *   (adds $1,000.00 to that client's tokenized_cents that was never
 *   really minted -- the on-chain balance stays exactly what it was,
 *   so the ledger now claims more than the chain actually holds)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { pool } = await import("../src/db/pool.js");

async function main() {
  const clientName = process.argv[2];
  const deltaCents = Number(process.argv[3]);

  if (!clientName || !Number.isInteger(deltaCents) || deltaCents === 0) {
    console.error('Usage: tsx scripts/inject-break.ts "<client name>" <delta_cents>');
    process.exit(1);
  }

  const { rows } = await pool.query(`SELECT id, name FROM clients WHERE name = $1`, [clientName]);
  if (rows.length === 0) {
    console.error(`No client named "${clientName}"`);
    process.exit(1);
  }
  const client = rows[0];

  const { rows: before } = await pool.query(
    `SELECT cash_balance_cents, tokenized_cents FROM ledger_balances WHERE client_id = $1`,
    [client.id],
  );
  console.log(`Before: cash=${before[0].cash_balance_cents}, tokenized=${before[0].tokenized_cents}`);

  const { rows: after } = await pool.query(
    `UPDATE ledger_balances SET tokenized_cents = tokenized_cents + $1, updated_at = now()
     WHERE client_id = $2
     RETURNING cash_balance_cents, tokenized_cents`,
    [deltaCents, client.id],
  );
  console.log(`After:  cash=${after[0].cash_balance_cents}, tokenized=${after[0].tokenized_cents}`);
  console.log(
    `Injected a ${deltaCents}-cent break for "${client.name}" — Postgres now claims ${deltaCents} cents ` +
      `${deltaCents > 0 ? "more" : "fewer"} tokenized than actually exist on-chain. Run reconciliation to confirm it's caught.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
