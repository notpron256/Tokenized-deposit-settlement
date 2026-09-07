# Tokenized Deposit Settlement

A proof-of-concept tokenized deposit settlement system on Solana: a mocked core banking ledger (Postgres) stays the sole legal source of truth for the deposit liability, while a Token-2022 mint provides a synchronized, on-chain-verifiable representation of it, with compliance (KYC gating, Travel Rule, sanctions screening, velocity limits) enforced by a real deployed Transfer Hook program rather than only in backend logic.

See [`intent/intent-001.md`](intent/intent-001.md), [`spec/spec-001.md`](spec/spec-001.md), and [`plan/plan-001.md`](plan/plan-001.md) for the requirements, design, and phase-by-phase build plan this project follows. See [`VERIFICATION.md`](VERIFICATION.md) for a command-line runbook that independently checks this project's compliance claims without going through the app's own UI or API.

## Networks

This project deliberately runs against two independent networks, never mixed:

- **Local validator** (`solana-test-validator`) — fast, free, disposable. Was the active development environment through Phase 9; **no longer actively maintained as of Phase 10 (2026-09-07)**. Its persisted ledger (`~/test-ledger`, outside this repo) became corrupted (`failed to load bank from snapshot ... account paths mismatching`) and running a local validator had also become genuinely taxing on the machine it ran on. The corrupted ledger was not rebuilt — see Areas of concern in `spec-001.md` for the full note. Everything the redemption-gateway program needed from local has already been exercised and is documented in `plan-001.md`'s Phase 8 done-test; there's no further local-only work outstanding.
- **Public devnet** — now the **primary and only actively used environment**. A promoted snapshot of the stable, tested pieces: the compliance-hook program, the Token-2022 mint (with its Default Account State / Permanent Delegate / Transfer Hook extensions), and the sanctions registry PDA. The redemption-gateway program is also promoted here (Phase 8 completed before local was retired).

`SOLANA_RPC_URL`, `DATABASE_URL`, and the `backend/keys/<network>/` directory they imply always move together as one group — see [`.env.example`](.env.example) for the exact local/devnet variable pairs. There is no separate "which network" flag; check those two values together to know which environment is currently active.

**Current devnet state, as of the last promotion:**
- compliance-hook: deployed at the same program ID as local (`9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z`), reusing the same tracked deploy keypair.
- Mint: created fresh on devnet with all three extensions, independently confirmed via `spl-token display` and via the standard (non-custom-RPC) Solana Explorer and Solscan.
- Sanctions registry: contains **only the `SyntheticTest` entry** (Sanctioned Test Corp). Real OFAC SDN sync is Phase 7, which hasn't been built yet — promoting the registry to devnet didn't and couldn't change that; there is no real sanctions data on either network yet.
- A representative client set (including Sanctioned Test Corp) onboarded and verified end-to-end: onboarding, funding, a settled transfer, a sanctions-blocked transfer, and the Transaction Evidence view, all confirmed live against devnet and independently visible via public Explorer/Solscan links with no custom RPC configuration.

## Quick start (devnet)

Local is no longer maintained (see Networks above) — devnet is the environment to run against.

1. `.env` pointed at the devnet block (see `.env.example`): `SOLANA_RPC_URL=https://api.devnet.solana.com`, `DATABASE_URL=postgresql://deposit_poc:deposit_poc@localhost:5432/deposit_poc_devnet`.
2. `docker compose up -d` (Postgres, and the Phase 6 off-chain indexer — see below). This starts Postgres only; devnet itself needs no local validator process.
3. `cd backend && npm install && npm run db:migrate && npm run setup:mint` (idempotent — reuses the existing devnet mint rather than creating a new one).
4. `cd backend && npm run dev` / `cd frontend && npm install && npm run dev`.

`backend/keys/devnet/` holds the devnet bank-ops authority and mint address. `npm run reset` (`backend/scripts/reset-demo.ts`) wipes and re-seeds the Postgres side of whichever network is currently active in `.env` for a clean demo state — it never touches on-chain state (mint, programs, sanctions registry). See that script's own header comment for exactly what it does and doesn't do.

## Off-chain indexer

`docker compose up` also starts an `indexer` service (`backend/scripts/indexer.ts`), which independently reconstructs every transfer that reaches the chain — signature, both parties, amount, memo fields, large-transaction flag — purely from on-chain data, never by trusting the backend's own Postgres writes. It backfills on startup, then watches live. It reads the same `.env` as everything else, so it always follows whichever network (local/devnet) is currently active.

**This only provides coverage while the container is actually running.** There is no restart policy on it and no supervisory process behind it — a crash or a dropped RPC subscription just means it silently stops indexing until someone notices and restarts it (`docker compose up -d indexer`). A missed transfer isn't lost forever (a later backfill picks it up from the chain's own history), but it won't show up on the Compliance page until then. This is a deliberate, named POC-scope limitation, not an assumed guarantee — see `spec-001.md`'s Areas of concern for the full reasoning and the real incident that surfaced it.
