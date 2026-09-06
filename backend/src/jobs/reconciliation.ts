/**
 * Phase 9 (plan-001.md): reconciliation. Two invariants, not one
 * (spec-001.md, Reconciliation):
 *
 * 1. Aggregate check — total tokens in circulation (the mint's own
 *    `supply`, read fresh on-chain — genuinely independent of the
 *    per-client loop below, so a token minted/held outside any known
 *    client ATA would still be caught) vs. the sum of every client's
 *    `tokenized_cents` *plus* the bank recovery ATA's own on-chain
 *    balance (Phase 6.5 clawback moves tokens there, not to any client,
 *    and deliberately never burns them — found the hard way, empirically,
 *    the first time this check actually ran against real post-clawback
 *    data: without this term every past clawback permanently looked like
 *    an unexplained aggregate break, when the tokens were always fully
 *    accounted for, just sitting in a known, legitimate, non-client
 *    holder rather than missing).
 * 2. Per-client check — each individual client's real on-chain ATA
 *    balance vs. their own `tokenized_cents`. The authoritative check:
 *    an aggregate match can hide two clients' errors netting to zero.
 *
 * Both checks compare against `tokenized_cents` specifically, never
 * `cash_balance_cents` — consistent with clawback/redemption both only
 * ever moving the tokenized side (spec-001.md, Areas of concern).
 *
 * On-chain balances are read live, directly from the chain (`getAccount`/
 * `getMint`) — never from anything this backend's own transfer/fund/
 * clawback/redeem flows wrote to Postgres. Checking a system against its
 * own bookkeeping wouldn't prove anything; this is the same reasoning
 * behind the Phase 6 indexer's own independence and the Evidence view's
 * fresh on-chain reads.
 *
 * A detected per-client mismatch is further classified before being
 * recorded (plan-001.md decision #5: "a stuck pending_chain row is
 * exactly what reconciliation is meant to surface"): if it exactly
 * matches the sum of that client's non-terminal-but-confirmed-on-chain
 * events (status = 'confirmed', a real tx_signature, not yet 'settled'
 * — i.e. the chain action genuinely happened but Postgres never caught
 * up), it's classified `in_flight` — an operational/timing artifact, not
 * a data-integrity error. Anything else is `unexplained` and must never
 * be laundered into looking like a timing artifact just because some
 * unrelated in-flight event happens to also exist for that client.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { pool } from "../db/pool.js";
import { loadOrCreateBankOpsKeypair } from "../solana/authorities.js";

export type BreakType = "aggregate" | "per_client";
export type BreakClassification = "unexplained" | "in_flight";

export interface ReconciliationBreak {
  clientId: string | null;
  clientName: string | null;
  breakType: BreakType;
  classification: BreakClassification;
  expectedCents: number;
  actualCents: number;
  deltaCents: number;
  note: string | null;
}

export interface ReconciliationRunResult {
  ranAt: string;
  clientsChecked: number;
  aggregateExpectedCents: number;
  aggregateActualCents: number;
  breaks: ReconciliationBreak[];
  allClear: boolean;
}

interface InFlightEvent {
  table: string;
  amountCents: number;
  direction: 1 | -1;
}

/** Every non-terminal-but-genuinely-on-chain event for this client, across
 * all four value-moving flows, signed by the direction it moves their
 * tokenized balance. Only `status = 'confirmed'` rows with a real
 * `tx_signature` qualify — a bare `pending_chain` row (this codebase never
 * sets a signature before reaching `confirmed`) carries no evidence the
 * chain action actually happened, so it can't be used to explain
 * anything; treating it as if it could would risk waving away a genuine
 * break. */
async function findInFlightEvents(clientId: string): Promise<InFlightEvent[]> {
  const events: InFlightEvent[] = [];

  const [deposits, transfersIn, transfersOut, redemptions, clawbacks] = await Promise.all([
    pool.query(
      `SELECT amount_cents FROM deposit_events WHERE client_id = $1 AND status = 'confirmed' AND tx_signature IS NOT NULL`,
      [clientId],
    ),
    pool.query(
      `SELECT amount_cents FROM transfer_events WHERE recipient_client_id = $1 AND status = 'confirmed' AND tx_signature IS NOT NULL`,
      [clientId],
    ),
    pool.query(
      `SELECT amount_cents FROM transfer_events WHERE sender_client_id = $1 AND status = 'confirmed' AND tx_signature IS NOT NULL`,
      [clientId],
    ),
    pool.query(
      `SELECT amount_cents FROM redemption_requests WHERE client_id = $1 AND status = 'confirmed' AND tx_signature IS NOT NULL`,
      [clientId],
    ),
    pool.query(
      `SELECT amount_cents FROM clawback_events WHERE client_id = $1 AND status = 'confirmed' AND tx_signature IS NOT NULL`,
      [clientId],
    ),
  ]);

  for (const row of deposits.rows) events.push({ table: "deposit_events", amountCents: Number(row.amount_cents), direction: 1 });
  for (const row of transfersIn.rows) events.push({ table: "transfer_events (in)", amountCents: Number(row.amount_cents), direction: 1 });
  for (const row of transfersOut.rows) events.push({ table: "transfer_events (out)", amountCents: Number(row.amount_cents), direction: -1 });
  for (const row of redemptions.rows) events.push({ table: "redemption_requests", amountCents: Number(row.amount_cents), direction: -1 });
  for (const row of clawbacks.rows) events.push({ table: "clawback_events", amountCents: Number(row.amount_cents), direction: -1 });

  return events;
}

async function classifyBreak(
  clientId: string,
  deltaCents: number,
): Promise<{ classification: BreakClassification; note: string | null }> {
  const events = await findInFlightEvents(clientId);
  if (events.length === 0) {
    return { classification: "unexplained", note: null };
  }

  const explainedDelta = events.reduce((sum, e) => sum + e.direction * e.amountCents, 0);
  if (explainedDelta === deltaCents) {
    const summary = events.map((e) => `${e.table}: ${e.direction > 0 ? "+" : "-"}${e.amountCents}`).join(", ");
    return {
      classification: "in_flight",
      note: `Matches ${events.length} confirmed-but-not-settled event(s) for this client (${summary}) — the on-chain action already happened, Postgres just hasn't caught up. Operational timing artifact, not a data-integrity error.`,
    };
  }

  return {
    classification: "unexplained",
    note: `${events.length} confirmed-but-not-settled event(s) exist for this client but do not fully account for the ${deltaCents}-cent delta — treated as unexplained rather than assumed to be a timing artifact.`,
  };
}

export async function runReconciliation(connection: Connection, mint: PublicKey): Promise<ReconciliationRunResult> {
  const { rows: clients } = await pool.query(
    `SELECT c.id, c.name, c.ata_address, l.tokenized_cents
     FROM clients c
     JOIN ledger_balances l ON l.client_id = c.id`,
  );

  let aggregateExpectedCents = 0;
  const breaks: ReconciliationBreak[] = [];

  for (const client of clients) {
    aggregateExpectedCents += Number(client.tokenized_cents);

    const account = await getAccount(connection, new PublicKey(client.ata_address), "confirmed", TOKEN_2022_PROGRAM_ID);
    const actualCents = Number(account.amount);
    const expectedCents = Number(client.tokenized_cents);

    if (actualCents !== expectedCents) {
      const deltaCents = actualCents - expectedCents;
      const { classification, note } = await classifyBreak(client.id, deltaCents);
      breaks.push({
        clientId: client.id,
        clientName: client.name,
        breakType: "per_client",
        classification,
        expectedCents,
        actualCents,
        deltaCents,
        note,
      });
    }
  }

  // The bank recovery ATA (Phase 6.5 clawback's destination) is a real,
  // legitimate, non-burned token holder outside the client set -- its
  // balance is part of expected circulating supply too, or every past
  // clawback would permanently register as an unexplained aggregate
  // break. Read directly (0 if the account has never been created --
  // ensureBankRecoveryAta's own idempotent creation is clawback's job,
  // not reconciliation's; a read-only check should never have the side
  // effect of creating an account).
  const bankOps = await loadOrCreateBankOpsKeypair(connection);
  const recoveryAta = getAssociatedTokenAddressSync(mint, bankOps.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const recoveryAtaInfo = await connection.getAccountInfo(recoveryAta);
  const recoveryAtaBalanceCents = recoveryAtaInfo
    ? Number((await getAccount(connection, recoveryAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount)
    : 0;
  aggregateExpectedCents += recoveryAtaBalanceCents;

  // Aggregate check: mint's own on-chain supply, read fresh -- genuinely
  // independent of the per-client loop above (would still catch tokens
  // minted/held outside any known client ATA or the bank recovery ATA,
  // which summing known holders could never detect).
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const aggregateActualCents = Number(mintInfo.supply);

  if (aggregateActualCents !== aggregateExpectedCents) {
    breaks.unshift({
      clientId: null,
      clientName: null,
      breakType: "aggregate",
      classification: "unexplained",
      expectedCents: aggregateExpectedCents,
      actualCents: aggregateActualCents,
      deltaCents: aggregateActualCents - aggregateExpectedCents,
      note: null,
    });
  }

  for (const b of breaks) {
    await pool.query(
      `INSERT INTO reconciliation_breaks (client_id, expected_cents, actual_cents, delta_cents, break_type, classification, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [b.clientId, b.expectedCents, b.actualCents, b.deltaCents, b.breakType, b.classification, b.note],
    );
  }

  return {
    ranAt: new Date().toISOString(),
    clientsChecked: clients.length,
    aggregateExpectedCents,
    aggregateActualCents,
    breaks,
    allClear: breaks.length === 0,
  };
}
