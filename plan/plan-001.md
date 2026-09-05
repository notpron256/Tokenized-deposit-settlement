# Plan 001: Tokenized Deposit Settlement — Implementation Plan

Author: Sebastian Higgs (drafted by Claude)
Status: Draft — pending review
Source: [intent/intent-001.md](../intent/intent-001.md), [spec/spec-001.md](../spec/spec-001.md)

## Environment

Solana `solana-test-validator` (localhost:8899), already running and funded (500,000,100 SOL in the default keypair — no funding action needed today). Real devnet later, once faucet access is available, but nothing in this plan assumes devnet specifically; it should all work identically against localhost. Anchor CLI 1.1.2, Rust 1.98 confirmed installed.

## One thing to verify before anything else

Spec-001 asserts a Token-2022 **"Permissioned Burn" mint extension** that requires a burn-authority co-signature. It's not confirmed that this is a literal extension name in the current `spl-token-2022` / `@solana/spl-token` API — it may instead mean "make `Burn` require two signatures," achievable today with zero custom extensions by making the ATA's owner/authority a standard **2-of-2 SPL Token multisig** (client key + bank burn-authority key). Functionally identical outcome, different mechanism. Resolved with a runnable spike as step one (Phase 0.5) rather than guessed.

Similarly, "Required Memo" is, as commonly implemented, an **account-level** extension (`MemoTransfer`, opt-in per ATA), not mint-level — meaning onboarding has to enable it per-account, not once at mint creation. Confirmed in the same spike.

## Decisions made for this plan (flag if a different call is wanted)

| # | Spec open question | Decision for this POC | Why |
|---|---|---|---|
| 1 | Redemption trigger | Explicit action from the frontend (button → API call), not a simulated feed | Only deposits were pinned to "no manual entry" in the intent doc; redemption is the flow you'll want to click through directly |
| 2 | Reconciliation cadence | On-demand "Run reconciliation" button as primary, plus a background interval (every 5 min) for realism | Matches the click-to-verify posture; interval shows it also runs unattended |
| 3 | Break routing | Frontend dashboard tab + Postgres log table. No paging/email | POC scope |
| 4 | Key custody | Two local keypair files: `bank-ops` (mint/freeze/permanent-delegate/burn authority) and `sanctions-sync` (registry sync authority only), plaintext JSON, gitignored | Spec explicitly says a placeholder single-key setup is fine for POC; kept the sync key separate since the spec calls that distinction out specifically |
| 5 | Cross-system atomicity | Ledger row gets a `status` column (`pending_chain` → `confirmed`/`failed`); no saga/compensation logic. A stuck `pending_chain` row is exactly what reconciliation is meant to surface | Matches how the spec frames reconciliation's role |
| 6 | Client wallet model (not raised in spec, but load-bearing) | Simulated "clients" have no external wallet — the backend holds every client's ATA-owner keypair too, alongside the bank's authority keys. **Confirmed with the user; recorded as a named, deliberate scope decision in spec-001.md's Areas of concern (not left implicit).** | Intent doc never describes client-side wallet UX; these are simulated institutional clients, and the point is compliance enforced at the token level, not wallet UX. Contrast noted against JPM Coin's actual client-side-key model |
| 7 | Demonstrating a sanctions hit | Real OFAC data is very unlikely to contain a Solana address (spec says so itself). Seed one synthetic "sanctioned" test address into the on-chain registry, **tagged with an explicit source field (`OfacSdn` vs. `SyntheticTest`) in the registry's own data structure — not just described as synthetic in prose or docs.** The Compliance UI renders a visible real/synthetic badge on every registry entry and on every block reason that cites one | Otherwise the sanctions-block checks can never be demoed to actually fail, and an undistinguished synthetic entry would misrepresent it as a real OFAC hit — same honesty standard as the STUB/LIVE labeling from the previous project |
| 8 | Postgres | Local Postgres via `docker-compose.yml` | Reproducible, one command to stand up — needs confirming Docker is available, or a local install used instead |

## Build order

### Phase 0 — Repo scaffold ✅
Files: `programs/compliance-hook/` (Anchor workspace init), `backend/` (Express + TS skeleton), `frontend/` (Vite + React + TS skeleton), `docker-compose.yml` (Postgres), `.env.example`.

**Done test:** `docker compose up -d`, then `npm run dev` in `frontend/` opens `localhost:5173` showing a blank shell page with nav tabs (Onboarding / Fund / Transfer / Redeem / Compliance / Reconciliation) and no crashes.

### Phase 0.5 — Extension verification spike ✅
File: `backend/scripts/verify-extensions.ts`.

Creates a throwaway Token-2022 mint on localhost configured with Default Account State, Permanent Delegate, Transfer Hook (pointed at a placeholder program ID), and whatever the real burn-co-sign mechanism turns out to be; creates one ATA and enables `MemoTransfer` on it.

**Done test:** run `npx tsx backend/scripts/verify-extensions.ts` — it prints each extension it applied and reads back from the mint/account to confirm, ending in `ALL EXTENSIONS VERIFIED` or a clear failure. This determines whether the Phase 8 burn step uses a native extension or the multisig-authority approach.

### Phase 1 — Transfer Hook / compliance Anchor program
Built in five verifiable increments (`programs/compliance-hook/src/lib.rs` + Anchor tests in `programs/compliance-hook/tests/`):

- **1a.** ✅ Scaffold + `initialize_extra_account_meta_list` only, all checks stubbed to pass.
  **Done test:** `anchor build && anchor deploy`, then `solana program show <PROGRAM_ID>` against localhost shows it deployed.
- **1b.** ✅ Velocity-limit check (init velocity account + running-total/window logic).
  **Done test:** `anchor test` output shows a passing scenario (transfer under cap succeeds) and a failing-as-expected scenario (transfer over cap reverts), printed with clear ✅/❌ per case. **Verified**, both in `anchor test` and against the real persistent validator.
- **1c.** ✅ Travel Rule memo check, upgraded to MT103-tagged fields (`:20:`/`:50K:`/`:59:`/`:70:`) after the initial 3-field placeholder — see spec-001.md.
  **Done test:** `anchor test` scenario — transfer with no memo reverts, transfer with well-formed memo succeeds. Also covers a malformed-but-present memo reverting (missing tag / empty field), added per the negative-case-coverage norm in AGENTS.md. **Verified**, both in `anchor test` and against the real persistent validator.
- **1d.** ✅ Sanctions registry (init/update instructions + hook read). Each registry entry stores `{ address: Pubkey, source: u8 }` — `0` = `OfacSdn`, `1` = `SyntheticTest`, as named constants rather than a literal Rust `enum` (same reasoning as `risk_rating` in 1b: avoids depending on borsh's enum-derive behavior in this Anchor version, a detail worth naming since it wasn't decided until implementation), not a flat pubkey list — so the real/synthetic distinction is a data-structure fact, not a label applied later off-chain.
  **Done test:** `anchor test` seeds one entry tagged `SyntheticTest` into the registry, shows a transfer involving it reverting, and an unrelated transfer succeeding. **Verified**, both in `anchor test` and against the real persistent validator (`backend/scripts/verify-sanctions-registry-onchain.ts`).
- **1e.** Large-transaction flag (event emit at ≥$10,000, non-blocking).
  **Done test:** `anchor test` shows a ≥$10,000 transfer succeeding *and* an emitted log/event captured in the test output.

### Phase 2 — Real mint creation script
File: `backend/scripts/create-mint.ts` (uses the real, now-deployed hook program ID from Phase 1; applies the resolution from Phase 0.5's spike for the burn mechanism).

**Done test:** `npm run setup:mint`, prints the mint address; run `spl-token display <MINT> --program-2022` and see all the extensions listed.

### Phase 3 — Postgres schema + onboarding flow
Files: `backend/src/db/schema.sql` (`clients`, `ledger_balances`, `deposit_events`, `redemption_requests`, `reconciliation_breaks`, `compliance_flags`), `backend/src/routes/onboarding.ts`, `backend/src/solana/onboarding.ts` (create ATA, thaw, enable `MemoTransfer`, init velocity account with risk rating), frontend Onboarding page (form: name, risk rating → "Onboard" button).

**Done test:** click "Onboard Client" for a new client, UI shows status flip to "Active" with the chosen risk tier; `spl-token account-info <ATA> --program-2022` in the terminal confirms it's no longer frozen.

### Phase 4 — Fund/mint flow ✅
Files: `backend/src/routes/depositFeed.ts`, `backend/src/flows/mintFlow.ts`, frontend Fund page ("Simulate Deposit" button: pick client + amount).

**Done test:** click "Simulate Deposit ($X)" for an onboarded client — UI shows ledger cash balance and on-chain token balance both increase and match. Then try it against a *not-yet-onboarded* client — UI shows a clean rejection, not a stuck/frozen mint attempt. **Verified**: deposited $2,500.50 for Sunrise Capital through the browser UI — ledger cash balance, ledger tokenized amount, and the app's own on-chain read-back all showed $2,500.50, then independently cross-checked with `spl-token account-info --address <ATA>` on the real validator, which also reported `2500.5`. Negative case (not-yet-onboarded/nonexistent client) tested directly via the API — since the UI's client picker only lists already-onboarded clients, there's no way to trigger this path by clicking through the form, so it was exercised with `curl` against a nonexistent client ID: clean `404` with no `deposit_events` row written (confirmed by checking the table), i.e. no stuck pending_chain row and no attempted mint.

### Phase 5 — Transfer flow ✅
Files: `backend/src/flows/transferFlow.ts`, frontend Transfer page (sender, recipient, amount, originator/beneficiary memo fields).

**Done test**, four clicks — **Verified**, all through the browser UI:
- (a) normal transfer between two onboarded clients succeeds, both balances update. Verified: $100.00 Sunrise Capital → Acme Corp Treasury; both sides' ledger tokenized amounts and on-chain read-backs matched.
- (b) a transfer that exceeds the sender's hourly velocity cap fails with the on-chain rejection reason shown in the UI. Verified: $550,000.00 from Beta LLC Operating (High risk, $500,000/hr cap) → "Blocked: transfer would exceed the sender's hourly velocity limit."
- (c) a transfer with the memo field left blank fails. Verified: blank reference/remittance → "Blocked: no memo instruction precedes this transfer (Token-2022's Required Memo extension) — a well-formed Travel Rule memo is required immediately before it." (This is Token-2022's own MemoTransfer account extension rejecting outright, a layer below compliance-hook's own structural memo check — see Move/transfer flow's two-layer memo note.)
- (d) a transfer involving the seeded synthetic sanctioned address fails, and the UI's rejection reason visibly shows a "SYNTHETIC / TEST DATA" badge on that entry — never rendered as if it were a real OFAC hit. Verified: transfer to "Sanctioned Test Corp" (a normally-onboarded client whose owner address was separately registered in the on-chain SanctionsRegistry as a SyntheticTest entry via the new `seed-sanctions-registry.ts` script) → "Blocked: transfer involves a sanctioned party. Sanctioned Test Corp matches a sanctions registry entry — SYNTHETIC (TEST) — this is seeded test data for demoing the check, never a real OFAC hit."

Also spot-checked a $15,000.00 transfer (above the $10,000 large-transaction threshold) to confirm the non-blocking flag doesn't block a legitimate transfer — succeeded normally.

**Bug found and fixed while building this phase:** Phase 2's `create-mint.ts` never called `initialize_extra_account_meta_list` for the real production mint — it only pointed the mint at the hook program (`createInitializeTransferHookInstruction`), never created the hook program's own extra-account-meta-list PDA that Token-2022 needs to resolve the hook's extra accounts. Every transfer against the real mint failed with "An account required by the instruction is missing." Invisible to Phase 2's own done-test (`spl-token display` only inspects the mint's own extension config, not the separate PDA under the hook program), so it went uncaught until this phase's first real transfer attempt. Fixed by adding an idempotent `ensureExtraAccountMetaList` step to `create-mint.ts` and re-running `npm run setup:mint` to backfill it for the existing mint.

### Phase 6 — Off-chain indexer (scope broadened after Phase 5 — see below)
File: `backend/scripts/indexer.ts` — a standalone process (not bolted onto `server.ts`, matching spec-001.md's own "a service" framing), watching the compliance-hook **program's** logs (not enumerating individual client ATAs — every transfer CPIs into the same program, so this catches all of them automatically, including clients onboarded after the indexer starts) and durably logging **every transfer that actually reaches the chain**: signature, both parties' owner pubkeys, amount (derived from token balance deltas, never trusted from Postgres), the memo's reference/remittance/identity-hash fields, and the non-blocking large-transaction flag when present — not only `LargeTransactionFlag` events as originally scoped. Rejected transfers (velocity/memo/sanctions) are *not* part of this, and can't be — see spec-001.md's Technical approach for why that's a documented design choice (preflight-enabled submission), not a gap. Writes to a new indexer-owned table (e.g. `indexed_transfers`) with **no foreign key back to `clients`** — kept honestly independent of the backend's own tables, joined for display only at read time. Runs against whichever network (`SOLANA_RPC_URL`/`DATABASE_URL`) is currently active, same as every other backend component — not two simultaneous per-network instances. Frontend: Compliance page (flag list, plus a registry-entries view that renders each sanctions entry's `source` tag as a "REAL (OFAC SDN)" or "SYNTHETIC (TEST)" badge — the badge comes from the on-chain `source` field, not a hand-maintained UI list).

**Why broadened:** narrow (large-tx-flags-only) scope was fine until Phase 9 (Reconciliation) and the Transaction Evidence view (Phase 5) made clear what's actually needed: (1) Phase 9 needs a record of on-chain activity that's genuinely independent of the backend's own Postgres writes to check them against — a reconciliation job that compares the backend to itself proves nothing; (2) the Compliance page's flag list needs that same independence; (3) this is also what "bank-grade transaction history" actually requires under spec-001.md's core-ledger-as-truth axiom — a complete record reconstructed from the chain, not a byproduct of whichever requests happened to succeed through the app.

**Done test:** send a transfer ≥$10,000 (from Phase 5) — it succeeds, and within a couple seconds it appears on the Compliance page without touching the backend. Separately, open the registry-entries view and confirm the synthetic test entry is visibly badged as such. Additionally: confirm the indexer's own log contains a given transfer's full record purely by watching the chain — e.g. compare it against `transfer_events`/`ledger_balances` for the same transfer and confirm the indexer arrived at its record independently, not by reading Postgres.

### Phase 6.5 — Permanent Delegate clawback (compliance recovery) ✅
Files: `programs/compliance-hook/src/lib.rs` (Permanent-Delegate exemption — required first, see below), `backend/src/solana/clawback.ts` (bank recovery ATA lifecycle, memo, instruction building), `backend/src/flows/clawback.ts` (orchestration: ledger-first, confirmed → finalized → settled gating), `backend/src/routes/clawback.ts`, frontend Compliance page addition (a "Permanent Delegate clawback" form + recent-clawbacks list).

This exercises the Permanent Delegate extension itself — configured on the mint since Phase 0.5/2, but otherwise unused elsewhere in this plan. It's distinct from Phase 8's redemption burn: clawback is a unilateral bank recovery action (e.g. a compromised or newly-sanctioned account), not a client-initiated, co-signed redemption.

**A real on-chain program gap was found and fixed before this could work at all** (spec-001.md, Areas of concern, has the full account — including the empirical proof that the original hook let a clawback out of a sanctioned account through undetected). The Transfer Hook's velocity/Travel-Rule/sanctions checks all assumed the signer is always the transferring client; a Permanent-Delegate-authorized transfer breaks that assumption. Fixed with a minimal, targeted change to `fallback()`: detect when the signer is the mint's own configured Permanent Delegate and skip all three blocking checks for that path — a genuine exemption, not a capped workaround — while leaving the non-blocking large-transaction flag running. Rebuilt, regression-tested, and redeployed to both local and devnet (local first, devnet only after the local regression suite passed).

Tokens move to a bank-owned recovery ATA (created + thawed once, idempotently) via `TransferChecked`, never `Burn`. The memo is deliberately NOT shaped like a Travel Rule memo (no ordering/beneficiary customer pair fits a bank-to-recovery movement) — a plain, honestly-labeled memo instead, carrying the real regulatory report reference and reason. On settlement, only `ledger_balances.tokenized_cents` moves; `cash_balance_cents` is left untouched (spec-001.md's SAR/DAML-freeze framing) — verified this produces zero Phase 9 reconciliation impact by construction, since that invariant only ever compares on-chain balance to `tokenized_cents`.

**Done test:** click "Clawback" against a test client's account for a specified amount (or the full live on-chain balance) — tokens move out of that account into the bank-controlled recovery account without any signature from the client's own key, and the client's on-chain balance drops accordingly. UI clearly labels this as a compliance-recovery action, distinct from redemption. Verified end-to-end via the real UI on devnet (not just the API): a full click-through submission against Devnet Beta Treasury settled, updated the on-screen balance and recent-clawbacks list live, and was independently picked up by the Phase 6 indexer's live watch within seconds.

### Phase 7 — Sanctions sync
File: `backend/src/jobs/sanctionsSync.ts`, frontend admin control ("Sync Now").

Every entry written by the real OFAC fetch is tagged `source: OfacSdn`; the synthetic test entry (seeded once, separately) stays tagged `source: SyntheticTest` and is never overwritten or relabeled by a sync run.

**Done test:** click "Sync Now" — UI/console shows "fetched N SDN entries, M Solana-format addresses found, registry updated," and the registry-entries view (Phase 6) shows the newly synced entries badged "REAL (OFAC SDN)" while the synthetic test address from Phase 0.5/2 remains badged "SYNTHETIC (TEST)."

### Phase 8 — Redeem/burn flow
Files: `backend/src/flows/redeemFlow.ts` (sanctions re-check → co-signed burn → ledger credit), frontend Redeem page.

**Done test:** click "Redeem $X" for a normal client — token balance decreases, ledger cash balance is credited, tokenized flag released. Then attempt redemption for the sanctioned test client — refused before any burn is attempted, with the "SYNTHETIC / TEST DATA" badge shown on the cited registry entry in the rejection reason.

### Phase 9 — Reconciliation
Files: `backend/src/jobs/reconciliation.ts` (aggregate + per-client checks), frontend Reconciliation dashboard, background 5-minute interval.

**Done test:** click "Run Reconciliation" with everything in sync — "all clear" result. Then run a provided script (`backend/scripts/inject-break.ts`) that manually edits one client's Postgres balance to simulate real-world drift, click "Run Reconciliation" again — a break record appears (client ID, expected, actual, delta, timestamp) on the dashboard.

### Phase 10 — Reset script + full walkthrough
File: `backend/scripts/reset-demo.ts` (wipes Postgres tables + re-runs mint/onboarding setup for a clean state).

**Done test:** run `npm run reset`, then click through all five flows back-to-back in one sitting with no backend restarts.

## Where input will likely be needed mid-build

- Confirming Docker is fine for Postgres (Phase 0), or using a local install instead.
- Phase 0.5's result — what the burn co-sign mechanism actually turns out to be, before Phases 1/2 lock it in.
- After `anchor build` generates the program keypair, the deployed program ID gets surfaced — no action needed, just flagging it's a generated artifact, not something to configure.
- If any `anchor deploy` fails because the local validator was restarted/reset since last checked (its state doesn't persist across restarts) — confirming `solana-test-validator` is still running before redeploying.
- Real OFAC SDN list fetch in Phase 7 needs outbound internet from wherever the backend runs — flagging in case of a firewall/proxy surprise.
