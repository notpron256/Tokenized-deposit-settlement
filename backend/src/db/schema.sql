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
-- decision #5): pending_chain -> confirmed/failed, ledger write first.
CREATE TABLE IF NOT EXISTS deposit_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    amount_cents    BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'failed')),
    tx_signature    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 8's redemption flow. Same pending_chain -> confirmed/failed pattern.
CREATE TABLE IF NOT EXISTS redemption_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id       UUID NOT NULL REFERENCES clients(id),
    amount_cents    BIGINT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending_chain' CHECK (status IN ('pending_chain', 'confirmed', 'failed', 'refused_sanctioned')),
    tx_signature    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Phase 6's off-chain indexer output: large-transaction flags (and any
-- other blocked-transfer reasons) read from Transfer Hook program logs.
CREATE TABLE IF NOT EXISTS compliance_flags (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_signature        TEXT NOT NULL,
    flag_type           TEXT NOT NULL,
    source_owner        TEXT,
    destination_owner   TEXT,
    amount_cents        BIGINT,
    details              JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
