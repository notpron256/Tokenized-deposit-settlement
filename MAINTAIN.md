# Production Monitoring (Design Artifact)

This document describes the production monitoring this system would need **if it were actually deployed for real**. Nothing here is wired up — there's no alerting, no dashboards, no monitoring code in this repo. This is a conceptual design artifact (Module 6 of the SDLC process this project follows), written so the shape of "how would we know something's wrong" is thought through before it's ever needed, not invented under pressure during a real incident.

Each signal below has: what it measures, a **just log it** threshold (routine, no action), and a **needs a human now** threshold (page someone / open an incident). Every threshold here is grounded in something this project actually found empirically, not guessed — where a real incident exists, it's named and cited.

## 1. Reconciliation break frequency/severity

**Measures**: the result of `POST /reconciliation/run` (`backend/src/jobs/reconciliation.ts`) — the true aggregate check (sum of every real on-chain token account this mint has ever held, vs. the mint's own on-chain `supply`), the per-client check (each client's real ATA balance vs. their `tokenized_cents`), and the two Phase 10 companion figures, `untrackedHoldersCount`/`untrackedHoldersCents`, which are informational, never a break.

- **Just log it**:
  - Any per-client break classified `in_flight` — a real on-chain signature exists for that client, Postgres just hasn't caught up to `settled` yet. This resolves itself on the next settlement-finality tick (see signal 4) and is expected background noise during any window with pending activity.
  - `untrackedHoldersCount`/`untrackedHoldersCents` staying flat between runs, or growing only in step with a known, logged `reset-demo.ts` invocation (the script requires a typed confirmation to run, so every reset is a deliberate, attributable event, not a silent one).
  - A clean run (`allAccountsTotalCents === mintSupplyCents`, zero breaks) — the routine, expected case.
- **Needs a human now**:
  - **Any `unexplained`-classified break, aggregate or per-client, that persists across two consecutive runs.** Grounded directly in what this project actually found: the *original* aggregate design (mint supply vs. sum of only currently-tracked Postgres clients) reported a **$45,134,588.99 "unexplained" break** the first time it ran after a Postgres-only demo reset — a number that looked catastrophic and was entirely a false alarm (every dollar was a real, legitimate, historical client balance that had simply fallen outside Postgres's current roster, not missing or wrong). The check was redesigned specifically so this can't happen again: it now sums every real on-chain holder and compares that true total to supply, which reconciles *by construction* — supply is definitionally the sum of every account's balance. Under the current design, any nonzero delta on the true aggregate check means the check's own accounting missed something (a real bug), not that a holder is untracked — so unlike a typical drift metric, there is no meaningful "small vs. large" gradation here to calibrate a dollar threshold against. **The right threshold for this signal is categorical (which bucket a break lands in), not a dollar magnitude** — do not set a rule like "alert only if the break exceeds $X," because that exact shape of rule is what would have made the $45.1M false alarm look *more* credible, not less.
  - `untrackedHoldersCents` **increasing** between runs with no corresponding reset event in the logs — this would mean an actively-tracked client's balance moved onto an address the ledger doesn't know about, i.e. real client funds becoming unaccounted for, which is categorically different from the expected one-time jump a reset produces.

## 2. Indexer uptime/liveness

**Measures**: whether `backend/scripts/indexer.ts`'s live watch (`connection.onLogs(HOOK_PROGRAM_ID, ...)`) is actually running and actually writing rows — time since the last `indexed_transfers` insert, cross-checked against whether any real hook-program activity happened on-chain in that window (a quiet indexer during a quiet chain is not a problem; a quiet indexer while other flows are successfully confirming transactions is).

- **Just log it**: no new `indexed_transfers` row for a few minutes with no corresponding on-chain activity either — normal for this project's bursty, manually-triggered traffic pattern, not a continuous production payment stream. A brief backfill-and-catch-up after a planned `docker compose restart indexer` is expected and self-healing.
- **Needs a human now**: no new block/signature processed for the hook program in **more than 15 minutes** while the RPC endpoint is confirmed reachable and other backend flows are successfully submitting and confirming transactions in the same window — real on-chain activity happening that the indexer isn't seeing. This threshold is deliberately much tighter than what this project actually experienced: a real **$40,000 devnet transfer went unindexed and unflagged for roughly an hour** (spec-001.md, Areas of concern), discovered only by chance, because at the time the indexer had only ever been started for one-off verification runs and killed each time afterward. That specific gap was later closed by wiring the indexer into `docker-compose.yml` so it starts automatically — but `docker-compose.yml` deliberately gives it no restart policy, unlike Postgres's own `restart: unless-stopped` (a named, written POC-scope decision, not an oversight). **That means the exact failure mode behind the $40,000 incident is still live today** — automatic startup is not the same as staying up, and nothing currently watches for the gap. This signal is the thing that would actually close it.

## 3. Sanctions-registry data freshness

**Measures**: time since the last successful real OFAC sync (`backend/src/jobs/sanctionsSync.ts`, "Sync Now"), and whether a sync actually succeeded (fetched, parsed, and wrote) versus merely being attempted.

- **Just log it**: routine gaps of days to low weeks between syncs. This project's own findings make this genuinely low-stakes at that timescale: as of the 09/04/2026 SDN publication, real Solana-tagged addresses number **4 entries, across only 3 distinct sanctioned parties, out of 19,329 total SDN entries** (spec-001.md, Areas of concern) — a new Solana-tagged OFAC designation is a rare event, so day-to-day staleness isn't informative the way it would be for a registry that changes constantly. A full sync is also cheap regardless of frequency, so there's no cost pressure pushing toward infrequent checks either — the honest driver for cadence is discipline, not expense.
- **Needs a human now**: two distinct triggers, not one —
  1. **Freshness-based**: no successful sync in longer than the cadence the business ultimately commits to (spec-001.md leaves this genuinely undecided — see Open questions). Not urgent because a miss is individually dangerous given how rare real hits are, but because an indefinitely-stale registry is a control that has silently stopped functioning, and given the rarity above, nobody would notice from the data alone.
  2. **Content-based, more urgent**: a sync fails outright (OFAC's SDN list service unreachable, an XML parse failure), **or** a sync's own diff shows an existing `SyntheticTest` entry was dropped rather than preserved. The sync logic is deliberately built to always carry forward existing synthetic entries during its full-replace write specifically so a real sync can never silently disable test/demo sanctions coverage — a sync that fails to preserve one means that guarantee itself has broken, which is a correctness bug in the sync path, not a freshness issue.

## 4. Settlement-finality latency

**Measures**: elapsed time between a transaction reaching Solana's `"confirmed"` commitment (row written at intermediate status) and reaching `"finalized"` (row flips to `settled`), across every value-moving flow — `deposit_events`, `transfer_events`, `redemption_requests`, `clawback_events` — via `backend/src/solana/finality.ts`.

- **Just log it**: the normal wait, typically ~15–20 seconds per transaction (matching this app's own UI copy: "Waiting for finalized settlement — this typically takes ~15-20s, reflecting Solana's actual finality guarantees"). Log every wait duration for trend visibility; the wait itself is intentional, not a defect — Areas of concern documents that this app originally settled at `"confirmed"` alone, one step short of Solana's strongest guarantee, and that was a real gap, found and fixed, specifically because a system settling actual deposit liabilities has a lower tolerance for that residual risk than most applications reasonably do.
- **Needs a human now**: a row stuck at `confirmed` — never reaching `settled` — for longer than a small multiple of the normal wait, e.g. **more than 5 minutes**. This is exactly the anomaly Phase 9/10's per-client reconciliation `in_flight` classification is built to explain after the fact (a `confirmed`-but-not-`settled` row with a real signature accounts for an otherwise-alarming balance delta) — but reconciliation in this project currently runs only on demand, with cadence deliberately left as an open question (spec-001.md, Open questions), so a genuinely stuck row could otherwise sit unnoticed until someone remembers to click "Run Reconciliation." A dedicated liveness check on `confirmed`-age closes that gap directly, catching the stall itself rather than waiting to reason backward from a reconciliation break it would eventually cause.

## Example: signal 2 trips — the intent.md that would be auto-opened

The scenario below is written as a live incident kickoff, not a hypothetical — this is what the on-call process would produce the moment signal 2's "needs a human now" threshold fires again, a second time.

```markdown
# Intent 002: Indexer Silent-Gap Incident (Recurrence)

Author: on-call (auto-filed by monitoring)
Status: Draft — Open Incident

## Problem

At 02:47 UTC on 2026-09-10, the indexer-liveness monitor (see MAINTAIN.md,
signal 2) tripped its alert threshold: no new row has been written to
`indexed_transfers` in over 15 minutes, while the devnet RPC endpoint is
confirmed reachable and other backend flows are successfully submitting
and confirming transactions on-chain in the same window. By the time this
intent was actually triaged, the true gap had grown to **68 minutes** —
the alert fired on schedule, but nobody actioned it promptly, which is
itself part of what this incident needs to fix, not a detail to gloss
over.

This is the second known occurrence of this exact failure mode. The first
(spec-001.md, Areas of concern) involved a real $40,000 devnet transfer
going unindexed and unflagged for roughly an hour, discovered only by
chance, because the indexer had only ever been started for one-off
verification runs and killed each time afterward. That incident's fix
wired the indexer into `docker-compose.yml` so it starts automatically —
but deliberately did not add a restart policy or process supervision (a
named, written POC-scope limitation, not an oversight). This recurrence
is exactly the risk that limitation predicted: the container can still go
quiet, unsupervised, and this time it did.

During the gap, at least one real transfer settled on-chain and is
missing from `indexed_transfers`: a $18,500.00 transfer from Devnet Alpha
Holdings to Gringotts Bank (confirmed via the app's own `transfer_events`
row, and independently re-derivable straight from the chain regardless of
whether this indexer ever saw it) is not showing on the Compliance page's
flag list or Activity History, and would not have surfaced at all except
for this alert firing.

## Proposed outcome

Restore indexing coverage immediately, confirm a full backfill closes the
specific gap window — the missing $18,500.00 transfer, and anything else
in the same window, must appear in `indexed_transfers` after backfill,
which is directly checkable — and determine why the container went quiet
this time specifically (crash vs. a silently dropped RPC subscription vs.
a host-level issue), so the fix addresses the actual cause, not just this
instance. Separately: since the alert fired correctly at the 15-minute
mark but triage didn't happen until 68 minutes, the escalation path
itself needs fixing alongside the technical root cause — a correctly-
firing alert nobody sees in time isn't meaningfully better than no alert.

## Affected users and systems

- Compliance, whose flag list and Activity History were incomplete for
  the full gap window — any large-transaction flag or sanctions-relevant
  activity in that window would have been invisible until backfill ran.
- Phase 9/10 reconciliation, which doesn't itself depend on
  `indexed_transfers` for its core balance checks (it reads on-chain ATA
  balances and mint supply directly) — worth explicitly confirming it
  stayed correct throughout, not just assuming it did because the design
  says it should.
- The indexer service itself (`backend/scripts/indexer.ts`,
  `docker-compose.yml`) and whatever replaces "no restart policy" as the
  real production answer to this failure mode.
- Any client whose transfer happened to land inside the gap window — from
  their own perspective nothing was wrong (it settled correctly on-chain
  and in the ledger), but compliance visibility into their activity was
  temporarily degraded, which matters precisely for the large-transaction
  and sanctions-relevant cases this indexer exists to surface quickly.

## Design principles

- Investigate before acting, the same precedent this process already
  follows: don't restart-and-close without confirming backfill actually
  recovered the missing window and without understanding why it went
  quiet, or this fires again with the same root cause still live.
- A missed transfer is not lost data — the signature is permanent and
  on-chain regardless of whether this indexer captured it live — but it
  is a real, time-bounded loss of *compliance visibility*. Keep that
  distinction explicit throughout: nothing needs recovering from the
  chain's perspective, monitoring coverage does.
- Per this project's own norm on flagging a deviation from an agreed
  design decision (CLAUDE.md): spec-001.md documents "no restart policy,
  no supervision" as a deliberate, named POC-scope limitation, not an
  oversight. If this incident's resolution is "add real process
  supervision," that's a genuine change to that documented decision, not
  a bug fix within it — it must be recorded as such, in spec-001.md's
  Areas of concern and this MAINTAIN.md, not quietly folded in as if
  supervision had been the plan all along.

## Constraints

- Do not backfill by silently widening the indexer's own signature-scan
  window as the sole fix — confirm root cause first, matching how the two
  real bugs found during Phase 9/10's own build were handled (the
  `seed-sanctions-registry.ts` RPC_URL module-load-order bug, and the
  `getProgramAccounts`-is-blocked-on-public-devnet-RPC finding) — both
  root-caused with a real, isolated repro before anything was changed.
- Do not mark this incident resolved on "backfill ran and the missing
  transfer now shows up" alone — that fixes the symptom for this specific
  gap, not the supervision gap that let it go undetected for 68 minutes
  despite a 15-minute alert threshold.

## Open questions

- Exact cause: did the `indexer` container exit (check `docker compose
  ps` / its exit code and logs around 02:47 UTC), or is it still running
  with its `onLogs` websocket subscription silently dropped — a distinct
  failure mode spec-001.md already names as possible, with no built-in
  way to detect it specifically today?
- Why did triage take until 68 minutes when the alert fired at 15 — was
  it never actually routed to anyone (a paging/escalation gap), or was it
  seen and not treated as urgent (a severity-calibration gap)? These need
  different fixes.
- Is the missing $18,500.00 transfer (Devnet Alpha Holdings → Gringotts
  Bank) the only casualty of this window, or are there others — confirm
  by diffing `indexed_transfers` before/after backfill against every
  `transfer_events` / `deposit_events` / `clawback_events` row with a
  `tx_signature` and a `created_at` inside the gap window.
- Does this — the second real data point after the original $40,000
  incident — justify committing to real process supervision (health
  checks, a restart policy, alerting on a detected gap) as part of the
  production roadmap, rather than continuing to defer it as POC-scope?
  That's a scope decision for the business to make deliberately, not
  something to resolve unilaterally inside this incident.
```
