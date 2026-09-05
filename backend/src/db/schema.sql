-- Phase 3 (plan-001.md): the mocked core banking ledger — the sole legal
-- source of truth for the deposit liability, per spec-001.md's design
-- principles. Only `clients` and `ledger_balances` are actually used by
-- Phase 3's onboarding flow; the rest are created now (per plan-001.md's
-- Phase 3 file list) so later phases have a stable schema to build against,
-- with columns kept minimal until the phase that owns them defines more.

CREATE TABLE IF NOT EXISTS clients (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    risk_rating     SMALLINT NOT NULL CHECK (risk_rating IN (0, 1, 2)), -- 0=low, 1=medium, 2=high — matches compliance-hook's RISK_LOW/MEDIUM/HIGH
    ata_address     TEXT NOT NULL UNIQUE, -- client's Token-2022 associated token account
    owner_address   TEXT NOT NULL UNIQUE, -- client's own (backend-custodied) pubkey — see spec-001.md's client wallet model decision
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settlement-finality gating (spec-001.md, Technical approach: "settled" vs
-- "finalized"): a client isn't trustworthy as 'active' until the onboarding
-- transaction reaches Solana's own "finalized" commitment, not merely
-- "confirmed" — before that, a confirmed-but-not-yet-finalized transaction
-- could in principle still be dropped. 'confirmed' is the new intermediate
-- value a client sits at between the on-chain transaction confirming and
-- finalizing; only 'active' means finalized. The column's implicit
-- DEFAULT 'active' from CREATE TABLE above is removed so the application
-- must always state this explicitly, never fall into it by omission.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_status_check;
ALTER TABLE clients ADD CONSTRAINT clients_status_check CHECK (status IN ('confirmed', 'active', 'suspended'));
ALTER TABLE clients ALTER COLUMN status DROP DEFAULT;

-- KYC reference: a free-text case/ticket ID the operator supplies, recording
-- where real KYC/risk-rating approval is claimed to have happened out-of-band.
-- Not verified against any real system — spec-001.md Areas of concern names
-- this as a deliberate scope decision, not an oversight. Added after clients
-- already existed, so backfilled rather than assumed present from the start.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS kyc_reference TEXT;
UPDATE clients SET kyc_reference = 'UNKNOWN (onboarded before KYC reference field existed)' WHERE kyc_reference IS NULL;
ALTER TABLE clients ALTER COLUMN kyc_reference SET NOT NULL;

-- Legal address and entity/registration ID: real identifying data captured
-- at onboarding for Travel Rule purposes (spec-001.md Move/transfer flow).
-- Never posted on-chain directly — the memo's :50K:/:59: fields carry a
-- reference ID (the client's own id, see backend/src/flows/transferFlow.ts)
-- that resolves to this real data only through the application's own
-- compliance views, industry-standard practice for crypto Travel Rule
-- compliance (TRISA, Notabene, the Travel Rule Protocol). Same backfill
-- pattern as kyc_reference above — added after clients already existed.
-- Placeholder wording is deliberately self-documenting (never a bare blank
-- or "N/A"), so it reads as an honest historical record in the app's own
-- compliance views, not a data gap that looks like a bug.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS registration_id TEXT;
UPDATE clients SET registration_id = 'REGISTRATION ID NOT COLLECTED — onboarded before this field existed' WHERE registration_id IS NULL;
ALTER TABLE clients ALTER COLUMN registration_id SET NOT NULL;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS legal_address TEXT;
UPDATE clients SET legal_address = 'ADDRESS NOT COLLECTED — onboarded before this field existed' WHERE legal_address IS NULL;
ALTER TABLE clients ALTER COLUMN legal_address SET NOT NULL;

-- Client keypairs are backend-custodied (spec-001.md Areas of concern: a
-- deliberate, named scope decision, not an oversight) and stored separately
-- from the client's public profile so a query against `clients` alone never
-- incidentally returns key material.
CREATE TABLE IF NOT EXISTS client_keys (
    client_id       UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    secret_key      JSONB NOT NULL -- the client keypair's raw secret key bytes, as a JSON array
);

CREATE TABLE IF NOT EXISTS ledger_balances (
    client_id           UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    cash_balance_cents  BIGINT NOT NULL DEFAULT 0,   -- total segregated cash balance
    tokenized_cents     BIGINT NOT NULL DEFAULT 0,   -- portion currently represented on-chain as tokens
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 4's simulated deposit event feed. `status` tracks the cross-system
-- atomicity gap named in spec-001.md's Areas of concern (plan-001.md
-- decision #5): pending_chain -> confirmed -> settled/failed, ledger write
-- first. 'confirmed' (Solana-confirmed, not yet finalized) is an
-- intermediate stage now, not terminal — see the settled-vs-finalized
-- migration below.
CREATE TABLE IF NOT EXISTS deposit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    amount_cents    BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'failed')),
    tx_signature    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 8's redemption flow. Same pending_chain -> confirmed -> settled/failed
-- pattern as deposit_events (see the settled-vs-finalized migration below);
-- schema is ready ahead of Phase 8's own build so the same gap doesn't need
-- retrofitting later.
CREATE TABLE IF NOT EXISTS redemption_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    amount_cents    BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'failed', 'refused_sanctioned')),
    tx_signature    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settlement-finality gating, added after deposit_events/redemption_requests
-- already existed (same backfill-migration pattern as kyc_reference etc.
-- above): both tables' 'confirmed' status meant "done, terminal" until now.
-- It's repurposed as an intermediate stage — Solana-confirmed, but not yet
-- finalized — and 'settled' is added as the new terminal success value.
-- "Settled" (the business/banking term: value has irrevocably moved) is
-- kept conceptually distinct from Solana's own technical "finalized"
-- commitment level — see spec-001.md's Technical approach for the full
-- distinction. Both CHECK constraints are dropped and recreated rather
-- than altered in place, since Postgres has no ADD-VALUE-IF-NOT-PRESENT
-- form for a CHECK constraint; safe to re-run.
ALTER TABLE deposit_events DROP CONSTRAINT IF EXISTS deposit_events_status_check;
ALTER TABLE deposit_events ADD CONSTRAINT deposit_events_status_check
    CHECK (status IN ('pending_chain', 'confirmed', 'settled', 'failed'));

ALTER TABLE redemption_requests DROP CONSTRAINT IF EXISTS redemption_requests_status_check;
ALTER TABLE redemption_requests ADD CONSTRAINT redemption_requests_status_check
    CHECK (status IN ('pending_chain', 'confirmed', 'settled', 'failed', 'refused_sanctioned'));

-- Phase 5's transfer flow never had its own event/status table (plan-001.md
-- originally decided against one — transfers only updated ledger_balances
-- directly). Reversed here: transfers need the same pending_chain ->
-- confirmed -> settled/failed settlement-finality tracking as deposits, so
-- there has to be a row for it to live on. Also gives a durable,
-- restart-proof record of every transfer attempt (including compliance
-- rejections, which land here as 'failed') independent of Solana's own
-- transaction-history retention on a local validator.
CREATE TABLE IF NOT EXISTS transfer_events (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_client_id      UUID NOT NULL REFERENCES clients(id),
    recipient_client_id   UUID NOT NULL REFERENCES clients(id),
    amount_cents          BIGINT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'settled', 'failed')),
    tx_signature          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 6's off-chain indexer (backend/scripts/indexer.ts): every transfer
-- that actually reached the chain, reconstructed purely from on-chain data
-- (transaction logs, memo content, token balance deltas) -- never by
-- reading transfer_events/ledger_balances. Deliberately has NO foreign key
-- back to clients: joins for display happen at read time only, so this
-- table's own correctness never depends on the backend's other tables
-- (spec-001.md, Technical approach). Rejected transfers (velocity/memo/
-- sanctions) never appear here -- they never reach the chain at all (see
-- spec-001.md for why that's a documented design choice, not a gap).
CREATE TABLE IF NOT EXISTS indexed_transfers (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_signature                TEXT NOT NULL UNIQUE,
    slot                        BIGINT NOT NULL,
    block_time                  TIMESTAMPTZ,
    sender_owner                TEXT NOT NULL,
    recipient_owner             TEXT NOT NULL,
    amount_cents                BIGINT NOT NULL,
    memo_reference              TEXT,
    memo_remittance             TEXT,
    ordering_client_id          TEXT,
    ordering_identity_hash      TEXT,
    beneficiary_client_id       TEXT,
    beneficiary_identity_hash   TEXT,
    large_transaction_flag      BOOLEAN NOT NULL DEFAULT false,
    indexed_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 9's reconciliation job. client_id is nullable for an aggregate-level
-- break (spec-001.md's two-invariant design: aggregate check + per-client check).
CREATE TABLE IF NOT EXISTS reconciliation_breaks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID REFERENCES clients(id),
    expected_cents  BIGINT NOT NULL,
    actual_cents    BIGINT NOT NULL,
    delta_cents     BIGINT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 6's off-chain indexer output: superseded by the
-- indexed_transfers.large_transaction_flag boolean column above (a
-- separate compliance_flags table was drafted early in Phase 6's design
-- but never matched what got built — a boolean was sufficient since
-- large-transaction is currently the only flag type the hook emits, and a
-- second table would only duplicate what's already on indexed_transfers).
-- This table was dropped from both the local and devnet databases when
-- this comment was corrected; if a future flag type ever needs its own
-- structured record, add it fresh rather than reviving this one.

-- Phase 6.5: Permanent Delegate clawback — a unilateral, bank-initiated
-- compliance-recovery action (spec-001.md, Areas of concern: the SAR/
-- DAML-freeze analogy), distinct from Phase 8's client-initiated,
-- co-signed redemption. Same pending_chain -> confirmed -> settled/failed
-- finality gating as every other value-moving flow (deposit_events,
-- transfer_events). On settlement, only `ledger_balances.tokenized_cents`
-- for `client_id` is decremented — cash_balance_cents is deliberately left
-- untouched: a clawback reclaims the on-chain token representation
-- pending investigation, it does not itself extinguish the underlying
-- legal deposit liability (that would need a separate, more formal
-- determination — e.g. a court order or regulatory forfeiture
-- proceeding). This is why Phase 9 reconciliation's core invariant
-- (on-chain ATA balance vs. tokenized_cents) is unaffected by a correctly
-- settled clawback: tokenized_cents is brought down to match the reduced
-- on-chain balance in the same step, so no break is ever produced by this
-- path alone. The resulting cash/tokenized gap is a real, deliberate
-- business state pending resolution — never to be confused with a
-- reconciliation break, and must stay visibly labeled as such wherever
-- shown (UI, future alerting).
CREATE TABLE IF NOT EXISTS clawback_events (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id                     UUID NOT NULL REFERENCES clients(id),
    amount_cents                  BIGINT NOT NULL,
    reason                        TEXT NOT NULL,
    -- Same honesty labeling as clients.kyc_reference: records where the
    -- operator claims a real Suspicious Activity Report (or equivalent)
    -- was filed out-of-band — e.g. an NCA/FinCEN case number — never
    -- independently verified or looked up against any real regulatory
    -- system.
    regulatory_report_reference   TEXT NOT NULL,
    status                        TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'settled', 'failed')),
    tx_signature                  TEXT,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
