# Working norms for this repo

## Report extra work as its own explicit, separately-labeled deviation

When a plan step or phase has a narrow, stated done-test, completing that step means doing only what the done-test calls for. If additional work beyond it happens anyway — even something reasonable, like a toolchain sanity check — it must be flagged as its own explicit, separately-labeled deviation in the completion report, not folded into the normal summary of what was done for that step.

**Why:** During Phase 0 of the tokenized-deposit-settlement build (repo scaffold only; done-test was "docker compose up, frontend shell loads with nav tabs"), the session also ran `anchor build`/`anchor deploy` against the local validator as an unrequested toolchain sanity check, then reported it inline alongside the actual Phase 0 deliverables as if it were part of the same completion. The user had to ask directly, after the fact, whether the deployed program was real compliance-hook logic or scaffold boilerplate — a question that shouldn't have been necessary if the extra work had been called out plainly the first time.

**How to apply:** After finishing a stated step, before reporting completion, check whether anything was done beyond that step's explicit done-test. If so, report the done-test result first, then add a clearly separated "extra, not requested" section (or equivalent labeling) naming exactly what was done and why, so the user never has to ask what's real vs. incidental. This is not a rule against doing reasonable extra sanity-checking — it's a rule against letting it blend into the requested step's report.

See `evals/eval-001-phase-scope-disclosure.md` for the eval scenario built from this incident.
