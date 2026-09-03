# Working norms for this repo

## Report extra work as its own explicit, separately-labeled deviation

When a plan step or phase has a narrow, stated done-test, completing that step means doing only what the done-test calls for. If additional work beyond it happens anyway — even something reasonable, like a toolchain sanity check — it must be flagged as its own explicit, separately-labeled deviation in the completion report, not folded into the normal summary of what was done for that step.

**Why:** During Phase 0 of the tokenized-deposit-settlement build (repo scaffold only; done-test was "docker compose up, frontend shell loads with nav tabs"), the session also ran `anchor build`/`anchor deploy` against the local validator as an unrequested toolchain sanity check, then reported it inline alongside the actual Phase 0 deliverables as if it were part of the same completion. The user had to ask directly, after the fact, whether the deployed program was real compliance-hook logic or scaffold boilerplate — a question that shouldn't have been necessary if the extra work had been called out plainly the first time.

**How to apply:** After finishing a stated step, before reporting completion, check whether anything was done beyond that step's explicit done-test. If so, report the done-test result first, then add a clearly separated "extra, not requested" section (or equivalent labeling) naming exactly what was done and why, so the user never has to ask what's real vs. incidental. This is not a rule against doing reasonable extra sanity-checking — it's a rule against letting it blend into the requested step's report.

See `evals/eval-001-phase-scope-disclosure.md` for the eval scenario built from this incident.

## Proactively flag missing negative-case coverage for compliance/security checks

When a stated done-test for a check whose actual job is to reject bad input — a compliance or security control, not an ordinary feature — only specifies a happy-path scenario, or when a check's validation logic is upgraded to add new, more specific failure modes, don't just satisfy the literal wording of what was asked. Testing "rejects malformed input" is often as important as testing "accepts valid input," and a done-test that only proves the accept-path isn't complete — at minimum, the gap needs to be raised, not silently left uncovered.

**Why:** Phase 1c's original done-test (plan-001.md) specified two scenarios for the Travel Rule memo check: a well-formed memo succeeding, and a completely absent memo reverting. When the memo format was later upgraded from a 3-field pipe-delimited placeholder to four MT103-tagged fields with real per-field validation (correct tag prefix, non-empty content), the test suite and on-chain verification script were updated to carry the *same two original scenarios* forward under the new format — but no test was added for the new failure mode the upgrade itself introduced: a memo that is present but malformed under the new field-by-field rules (a missing tag, or an empty tagged field). The work was reported as done and ready to commit without that gap being mentioned. The user had to ask directly whether that negative case existed before approving.

**How to apply:** When finishing work on a check whose job is to reject bad input — especially compliance/security-relevant logic — treat "does the reject path have test coverage for the specific failure modes this logic actually validates" as part of completing the work, not an optional extra. This applies with particular force when validation logic is made *more* structured or specific (e.g., presence-only → field-by-field), since the upgrade itself introduces new ways to fail that need their own coverage — carrying forward only the old scenarios under the new format isn't sufficient. If a negative case is missing, either add it or explicitly flag the gap in the completion report before presenting the work as ready to commit.

See `evals/eval-002-negative-case-coverage.md` for the eval scenario built from this incident.
