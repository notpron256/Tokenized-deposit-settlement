/**
 * Phase 9 (plan-001.md): reconciliation. Two invariants, not one
 * (spec-001.md, Reconciliation):
 *
 * 1. Aggregate check — every real on-chain token account that has ever
 *    held this mint, found independently of Postgres and summed, compared
 *    against the mint's own on-chain `supply`. These two quantities are
 *    the same number by the token program's own invariant (supply is
 *    definitionally the sum of every account's balance), so a real
 *    mismatch here means something is actually wrong with this check's
 *    own accounting (a missed account, a bug), not "some historical
 *    holder isn't in Postgres" — see the Phase 10 redesign note below for
 *    why that used to be conflated.
 *
 *    `getProgramAccounts` filtered by mint (the obvious way to enumerate
 *    every holder) is NOT viable here: public devnet RPC
 *    (api.devnet.solana.com) hard-refuses it for the Token-2022 program
 *    regardless of filters — "excluded from account secondary indexes" —
 *    confirmed empirically, a `dataSize` filter included. Instead,
 *    `findAllTokenAccountAddressesEverHeldMint` below scans
 *    `getSignaturesForAddress(mint)` (not the hook program — a plain
 *    MintTo/Burn never invokes the transfer hook, so scanning the hook
 *    program's own history would silently miss a client who only ever
 *    received a deposit and never transferred) and, for every signature,
 *    reads `meta.pre/postTokenBalances` — present on any transaction
 *    regardless of instruction type — to collect every token account
 *    address that ever carried a balance for this mint. Their current
 *    balances are then read directly (no program-account scan needed).
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
 * Phase 10 redesign — untracked historical holders are informational, not
 * a break: the original aggregate check (mint supply vs. sum of *only*
 * currently-active Postgres clients' `tokenized_cents` plus the bank
 * recovery ATA) was mathematically sound only as long as every on-chain
 * holder that ever existed was still tracked in Postgres. `reset-demo.ts`
 * (Phase 10) breaks that assumption on purpose — it wipes Postgres for a
 * clean demo roster while deliberately leaving on-chain state (including
 * old clients' real, untouched token balances) alone. The first
 * reconciliation run after a reset then reported a ~$45M "unexplained"
 * aggregate break: every pre-reset client's real on-chain balance, now
 * untracked. That's the exact same category of gap as the bank-recovery-
 * ATA fix above (a real, legitimate token holder the old check's
 * "expected" side didn't know about) — not a data-integrity error to
 * document away, so this check no longer sums only *known* holders and
 * compares that partial sum to supply. It sums *every* real holder
 * (`findAllTokenAccountAddressesEverHeldMint` + `fetchTokenAccountBalances`
 * below) and compares that to supply, which reconciles cleanly by
 * construction; the gap between the true
 * total and what Postgres currently tracks is surfaced separately, as
 * `untrackedHoldersCount`/`untrackedHoldersCents` on the result — fully
 * explained (historical data, not missing tokens) and therefore never
 * written to `reconciliation_breaks`.
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
  /** The mint's own on-chain `supply`. */
  mintSupplyCents: number;
  /** Sum of every real on-chain token account found for this mint
   * (`findAllTokenAccountAddressesEverHeldMint` + `fetchTokenAccountBalances`)
   * — reconciles against mintSupplyCents by the token program's own
   * invariant; a mismatch means this check's own accounting missed
   * something, not that a holder is untracked. */
  allAccountsTotalCents: number;
  /** Sum of currently-active Postgres clients' tokenized_cents plus the
   * bank recovery ATA — the portion of allAccountsTotalCents this app
   * currently has a client-level story for. */
  trackedCents: number;
  /** Real on-chain token accounts under this mint that are neither an
   * active Postgres client's ATA nor the bank recovery ATA — almost
   * always historical demo/test data from before a Postgres-only reset.
   * Informational: fully explained, never inserted as a break. */
  untrackedHoldersCount: number;
  untrackedHoldersCents: number;
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

interface MintTokenAccount {
  address: string;
  amountCents: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Public devnet RPC rate-limits aggressively once several getTransaction
// calls fire back-to-back -- the Phase 6 indexer hits the same thing
// (backend/scripts/indexer.ts) and uses 300ms; empirically that still
// wasn't enough headroom here once a handful of other calls (per-client
// balance reads, the mint read, this scan's own signature listing) share
// the same rate-limit window, so this scan uses a wider throttle plus
// its own outer retry (below) for whatever the wait alone doesn't cover.
const SCAN_THROTTLE_MS = 800;

/** @solana/web3.js already retries a 429 internally a few times before
 * giving up (visible as "Retrying after Nms delay" in stderr); this wraps
 * that with a slower outer retry for when even those are exhausted --
 * acceptable here since reconciliation is a manually-triggered, low-
 * frequency action, not a hot path. Gives up after `maxAttempts` and
 * returns null so one stubborn signature can't crash the whole run; a
 * transaction actually missing this way makes the aggregate check's own
 * total come up short against mint supply, which is exactly the "this
 * check's own accounting missed something" break case its design already
 * accounts for -- not silently swallowed. */
async function withRetry<T>(fn: () => Promise<T>, description: string, maxAttempts = 5): Promise<T | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error(`Reconciliation: giving up on ${description} after ${maxAttempts} attempts:`, err);
        return null;
      }
      await sleep(2000 * attempt);
    }
  }
  return null;
}

/** Every distinct token account address that has ever carried a balance
 * for `mint`, found by scanning the mint's own signature history (see
 * header comment for why this, not getProgramAccounts). A signature
 * appearing here doesn't mean the account still exists or still holds a
 * balance now -- callers read current balances separately. */
async function findAllTokenAccountAddressesEverHeldMint(connection: Connection, mint: PublicKey): Promise<PublicKey[]> {
  const addresses = new Set<string>();
  const mintBase58 = mint.toBase58();
  let before: string | undefined;
  const pageLimit = 1000;

  for (;;) {
    const page = await connection.getSignaturesForAddress(mint, { before, limit: pageLimit });
    if (page.length === 0) break;

    for (const info of page) {
      if (info.err) continue; // never actually reached under this app's preflight-enabled submission
      const tx = await withRetry(
        () => connection.getTransaction(info.signature, { maxSupportedTransactionVersion: 0 }),
        `getTransaction(${info.signature})`,
      );
      if (!tx) continue;

      const message = tx.transaction.message as unknown as {
        accountKeys?: { toBase58(): string }[];
        getAccountKeys?: () => { staticAccountKeys: { toBase58(): string }[] };
      };
      const keys = message.getAccountKeys ? message.getAccountKeys().staticAccountKeys : message.accountKeys ?? [];

      for (const bal of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) {
        if (bal.mint !== mintBase58) continue;
        const key = keys[bal.accountIndex];
        if (key) addresses.add(key.toBase58());
      }
      await sleep(SCAN_THROTTLE_MS);
    }

    before = page[page.length - 1].signature;
    if (page.length < pageLimit) break; // reached the end of retained history
  }

  return Array.from(addresses).map((a) => new PublicKey(a));
}

/** Reads current balances for a batch of known token account addresses --
 * no program-account scan needed once the addresses themselves are known.
 * An address with no account (closed, or never actually created despite
 * appearing in a stale balance snapshot) is simply omitted. */
async function fetchTokenAccountBalances(connection: Connection, addresses: PublicKey[]): Promise<MintTokenAccount[]> {
  const results: MintTokenAccount[] = [];
  const CHUNK = 100;

  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    infos.forEach((info, idx) => {
      if (!info) return;
      // Token account layout: mint (0-32), owner (32-64), amount (64-72,
      // u64 LE) -- fixed regardless of which extensions (if any) follow.
      const amount = info.data.readBigUInt64LE(64);
      results.push({ address: chunk[idx].toBase58(), amountCents: Number(amount) });
    });
  }

  return results;
}

export async function runReconciliation(connection: Connection, mint: PublicKey): Promise<ReconciliationRunResult> {
  const { rows: clients } = await pool.query(
    `SELECT c.id, c.name, c.ata_address, l.tokenized_cents
     FROM clients c
     JOIN ledger_balances l ON l.client_id = c.id`,
  );

  let trackedCents = 0;
  const breaks: ReconciliationBreak[] = [];

  for (const client of clients) {
    trackedCents += Number(client.tokenized_cents);

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
  trackedCents += recoveryAtaBalanceCents;

  // True aggregate check (Phase 10 redesign — see header comment): every
  // real on-chain token account that has ever held this mint, summed
  // independently of Postgres, vs. the mint's own reported supply. These
  // are the same quantity by the token program's own invariant, so this
  // should always reconcile; a mismatch means this check's own accounting
  // missed something (e.g. a signature the scan didn't reach), which is a
  // real bug worth surfacing as a break — unlike the old design, where
  // any legitimate holder outside Postgres's current roster always
  // looked like one.
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const mintSupplyCents = Number(mintInfo.supply);

  const everHeldAddresses = await findAllTokenAccountAddressesEverHeldMint(connection, mint);
  const allAccounts = await fetchTokenAccountBalances(connection, everHeldAddresses);
  const allAccountsTotalCents = allAccounts.reduce((sum, a) => sum + a.amountCents, 0);

  if (allAccountsTotalCents !== mintSupplyCents) {
    breaks.unshift({
      clientId: null,
      clientName: null,
      breakType: "aggregate",
      classification: "unexplained",
      expectedCents: mintSupplyCents,
      actualCents: allAccountsTotalCents,
      deltaCents: allAccountsTotalCents - mintSupplyCents,
      note: `Sum of ${allAccounts.length} real on-chain token account(s) found for this mint does not match the mint's own reported supply — this should be mathematically impossible under normal operation and points at a bug in this check itself (e.g. the signature scan not reaching every transaction), not a missing/untracked holder.`,
    });
  }

  // Untracked historical holders — informational, never a break (see
  // header comment): real on-chain accounts under this mint that aren't
  // an active Postgres client's ATA or the bank recovery ATA.
  const knownAddresses = new Set<string>([
    ...clients.map((c) => c.ata_address as string),
    recoveryAta.toBase58(),
  ]);
  const untrackedAccounts = allAccounts.filter((a) => !knownAddresses.has(a.address));
  const untrackedHoldersCount = untrackedAccounts.length;
  const untrackedHoldersCents = untrackedAccounts.reduce((sum, a) => sum + a.amountCents, 0);

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
    mintSupplyCents,
    allAccountsTotalCents,
    trackedCents,
    untrackedHoldersCount,
    untrackedHoldersCents,
    breaks,
    allClear: breaks.length === 0,
  };
}
