# Tokenized Deposit Settlement

A proof-of-concept tokenized deposit settlement system on Solana: a mocked core banking ledger (Postgres) stays the sole legal source of truth for the deposit liability, while a Token-2022 mint provides a synchronized, on-chain-verifiable representation of it, with compliance (KYC gating, Travel Rule, sanctions screening, velocity limits) enforced by a real deployed Transfer Hook program rather than only in backend logic.

See [`intent/intent-001.md`](intent/intent-001.md), [`spec/spec-001.md`](spec/spec-001.md), and [`plan/plan-001.md`](plan/plan-001.md) for the requirements, design, and phase-by-phase build plan this project follows. See [`VERIFICATION.md`](VERIFICATION.md) for a command-line runbook that independently checks this project's compliance claims without going through the app's own UI or API.

## Networks

This project deliberately runs against two independent networks, never mixed:

- **Local validator** (`solana-test-validator`) — fast, free, disposable. This is the active development environment: everything not yet promoted to devnet (currently the redemption-gateway program — still only the Phase 0.5 spike, not the real Phase 8 build) is built and tested here.
- **Public devnet** — a promoted snapshot of the stable, tested pieces once they're ready to be independently observable by anyone, not just this machine: the compliance-hook program, the Token-2022 mint (with its Default Account State / Permanent Delegate / Transfer Hook extensions), and the sanctions registry PDA. Redemption-gateway will be promoted the same way once Phase 8 is actually built.

`SOLANA_RPC_URL`, `DATABASE_URL`, and the `backend/keys/<network>/` directory they imply always move together as one group — see [`.env.example`](.env.example) for the exact local/devnet variable pairs. There is no separate "which network" flag; check those two values together to know which environment is currently active.

**Current devnet state, as of the last promotion:**
- compliance-hook: deployed at the same program ID as local (`9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z`), reusing the same tracked deploy keypair.
- Mint: created fresh on devnet with all three extensions, independently confirmed via `spl-token display` and via the standard (non-custom-RPC) Solana Explorer and Solscan.
- Sanctions registry: contains **only the `SyntheticTest` entry** (Sanctioned Test Corp). Real OFAC SDN sync is Phase 7, which hasn't been built yet — promoting the registry to devnet didn't and couldn't change that; there is no real sanctions data on either network yet.
- A representative client set (including Sanctioned Test Corp) onboarded and verified end-to-end: onboarding, funding, a settled transfer, a sanctions-blocked transfer, and the Transaction Evidence view, all confirmed live against devnet and independently visible via public Explorer/Solscan links with no custom RPC configuration.

## Quick start (local validator)

1. `solana-test-validator` running on `localhost:8899`.
2. `docker compose up -d` (Postgres, and the Phase 6 off-chain indexer — see below).
3. `cd backend && npm install && npm run db:migrate && npm run setup:mint`.
4. `cd backend && npm run dev` / `cd frontend && npm install && npm run dev`.

`backend/keys/local/` holds the local bank-ops authority and mint address, generated on first run.

## Off-chain indexer

`docker compose up` also starts an `indexer` service (`backend/scripts/indexer.ts`), which independently reconstructs every transfer that reaches the chain — signature, both parties, amount, memo fields, large-transaction flag — purely from on-chain data, never by trusting the backend's own Postgres writes. It backfills on startup, then watches live. It reads the same `.env` as everything else, so it always follows whichever network (local/devnet) is currently active.

**This only provides coverage while the container is actually running.** There is no restart policy on it and no supervisory process behind it — a crash or a dropped RPC subscription just means it silently stops indexing until someone notices and restarts it (`docker compose up -d indexer`). A missed transfer isn't lost forever (a later backfill picks it up from the chain's own history), but it won't show up on the Compliance page until then. This is a deliberate, named POC-scope limitation, not an assumed guarantee — see `spec-001.md`'s Areas of concern for the full reasoning and the real incident that surfaced it.
