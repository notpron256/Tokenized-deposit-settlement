# Spike: redeem-gateway co-sign verification

Status: archived. This is not part of the real system and is excluded from
the Anchor workspace (`programs/*`) on purpose — nothing here is built or
deployed as part of the actual application.

Decision record: **spec/spec-001.md**, "Redeem/burn flow" and "Token design"
sections. This spike is the underlying proof for that decision; treat
spec-001.md as the source of truth for the current architecture, and this
folder as the evidence trail for how it was reached.

## What this verified

Two things, on-chain — not just reasoned from SDK source:

1. **The Token-2022 `PermissionedBurn` extension is unusable on this local
   validator.** It's a real extension in the installed `@solana/spl-token`
   client SDK, but the Token-2022 program actually deployed on
   `solana-test-validator` (genesis-deployed, upgrade authority burned, not
   independently upgradeable) rejects its instruction with `Invalid
   instruction` (custom program error `0xc`). This ruled out the originally
   assumed mechanism and forced a real alternative.

2. **The redemption-gateway co-sign pattern works as an alternative,
   confirmed live on-chain:**
   - The client's ATA `owner` stays their own single key the entire time —
     never a shared/multisig authority (a naive "make owner a 2-of-2
     multisig" approach was considered and rejected first, since an SPL
     Token account's owner field authorizes *every* instruction on that
     account, not just burn — it would have forced bank co-signature onto
     ordinary transfers too, undermining the whole point of the Transfer
     Hook).
   - The client `Approve`s a program-derived address (PDA), owned by this
     spike's `redeem-gateway-spike` Anchor program, as a scoped delegate.
   - The gateway's own `redeem` instruction requires **two** Anchor
     `Signer`s — the client and a bank compliance signer — before it CPIs
     into the base SPL Token `Burn` instruction using the PDA as authority.

Actual results from `verify-redeem-gateway.ts`, run against
`solana-test-validator` on localhost:

```
--- Test A: client signature only (compliance signer omitted) ---
PASS — one-signature redeem correctly rejected: Signature verification failed.
Client ATA balance after Test A: 100000 (unchanged=true)

--- Test B: client + compliance signer, both present ---
PASS — two-signature redeem correctly succeeded: signature=5T2eUY9UmxwWQr1pf9XRvApq4iYr83Jqpp1eCSXJ5hiw5hhkZu8AAbTBiyAQVEbBM9qivpfc68fkEYkPDV2gyecT
Client ATA balance after Test B: 75000 (expected=75000, burn actually happened=true)

GATEWAY PATTERN VERIFIED: one signature fails, two signatures succeed, burn confirmed on-chain.
```

## Contents

- `program/` — the throwaway Anchor program (`redeem-gateway-spike`) that
  implements the gateway `redeem` instruction under test.
- `verify-redeem-gateway.ts` — the script that ran both test cases above.

## Re-running this spike

Both files depend on backend's installed dependencies
(`@solana/web3.js`, `@solana/spl-token`) and were originally run from
`backend/`. They're not wired into any npm script here. To re-run:

1. Temporarily copy `program/` back under `programs/` and add it to
   `Anchor.toml`'s `[programs.localnet]` (see git history for the exact
   entry used), then `anchor build && anchor deploy` it.
2. Temporarily copy `verify-redeem-gateway.ts` into `backend/scripts/` and
   run `npx tsx scripts/verify-redeem-gateway.ts` from `backend/`, so it can
   resolve dependencies from `backend/node_modules`.

This is deliberately not kept push-button runnable in place — it's an
archived proof, not a maintained package. Phase 1/8 of `plan/plan-001.md`
will build the real version against the real `compliance-hook` program, not
by reviving this one.
