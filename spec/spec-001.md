# Spec 001: Tokenized Deposit Settlement — Requirements and Design

Author: Sebastian Higgs
Status: Draft
Source: [intent/intent-001.md](../intent/intent-001.md)

## Summary

This spec resolves the open questions from intent-001 and specifies the fund/mint, transfer, and redeem/burn flows; the two-layer compliance model; the reconciliation approach; and the token design for a proof-of-concept tokenized deposit system on Solana devnet. The core banking ledger (mocked as Postgres) remains the sole legal source of truth for the deposit liability at all times; the Token-2022 token is a synchronized, verifiable representation of it, never a replacement for it. The gaps identified in the previous draft are now resolved: redemption burns are gated by the Permissioned Burn extension rather than a transfer-to-omnibus convention, the sanctions check is specified as an on-chain PDA snapshot read (never a live call), and both the velocity limit and large-transaction thresholds are now numerically defined. What remains open — cross-system atomicity between Postgres and Solana, the redemption trigger mechanism, reconciliation cadence/alerting, and the key custody model — are called out in Areas of concern and Open questions as genuine unresolved decisions, not oversights.

## Fund/mint flow

1. A simulated event feed emits a deposit event representing an incoming client cash deposit (amount, client ID, timestamp). This is the sole trigger for minting — there is no manual entry path.
2. The event handler books the amount against the client's segregated balance in the Postgres ledger and marks it as tokenized.
3. The system mints the equivalent amount of tokens (integer cents, see Token design) to the client's associated token account (ATA).
4. Minting requires the client's ATA to already be unfrozen. A new ATA is created frozen by default (Default Account State); a client cannot receive a mint until compliance has explicitly thawed their account, which stands in for completed KYC/onboarding. This makes onboarding a hard prerequisite to the fund flow, not a parallel or later step — a deposit event for a not-yet-onboarded client should fail cleanly rather than mint into a frozen account. The same onboarding action also assigns the client's risk rating (low/medium/high) and initializes their on-chain velocity-tracking account, which the Transfer Hook reads on every subsequent transfer (see Move/transfer flow).
5. Minting is not itself checked by the Transfer Hook (see Move/transfer flow) — Token-2022 mint instructions don't invoke the transfer hook. Default Account State is the only on-chain gate at mint time.

Sequencing gap: step 2 (ledger booking) and step 3 (on-chain mint) are two separate systems with no atomic transaction spanning both. If the ledger booking succeeds but the mint fails (or vice versa), the two systems drift — which is exactly the class of break Reconciliation is meant to catch, but no reservation/compensation logic is defined yet to prevent or auto-heal it. Flagged in Areas of concern.

## Move/transfer flow (including compliance controls)

Compliance is enforced in two layers, both at the token level rather than at the network level:

**Layer 1 — Default Account State.** Every new token account is created frozen. It cannot send or receive tokens at all until compliance explicitly thaws it. This represents onboarding/KYC-level gating: a binary, account-level switch checked before any transfer logic runs.

**Layer 2 — Transfer Hook.** A real, deployed on-chain Solana program (Rust/Anchor) is invoked on every transfer via the Token-2022 Transfer Hook extension. It runs four checks:

1. **Velocity limit** — an aggregate-dollar-value cap per client account within a fixed one-hour window: the hook tracks a running total and a window-start timestamp on the client's velocity account; each transfer adds to the running total, and if more than an hour has elapsed since window-start, the total resets to zero and a new window begins. This is a fixed-window counter, not a true sliding window — a deliberate POC scope simplification, noted here rather than left implicit. The cap is tiered by client risk rating, assigned by compliance at onboarding (the same action that thaws Default Account State — see Fund/mint flow) and read from the client's on-chain velocity account at transfer time:
   - Low risk: $5,000,000 / hour
   - Medium risk: $2,000,000 / hour
   - High risk: $500,000 / hour
2. **Travel Rule check** — rejects any transfer missing well-formed originator/recipient identifying data. This data is carried in the Required Memo extension, formatted in the spirit of SWIFT MT103 fields (ordering customer, beneficiary customer, purpose/reference), and the hook parses and validates the memo's presence and structure before allowing the transfer.
3. **Sanctions re-screen** — checks both parties against an on-chain snapshot of OFAC's SDN list, re-checked at transfer time (not just at onboarding). The snapshot lives in an on-chain PDA, periodically synced by an off-chain process — see Technical approach for the precise mechanism. Solana-specific address coverage in the current public SDN list is likely thin-to-nonexistent, so an actual match is unlikely in practice — the point is demonstrating the mechanism (real government data, real parsing, real cross-referencing), not producing hits.
4. **Large-transaction flag** — flags any transfer of $10,000 or more, mirroring real CTR reporting thresholds. Non-blocking: the transfer proceeds, but the hook logs a complete record (transaction ID, amount, both parties, timestamp) at the point the transfer happens. Compliance handles the actual regulatory filing out-of-band, off the back of this log — the control's job is only to guarantee the record exists, not to file it.

Checks 1–3 are blocking: any failure reverts the transfer. Check 4 is non-blocking: it writes a flag (via on-chain program log / event) that an off-chain indexer picks up and records, but the transfer proceeds.

This is a deliberate architectural choice, not an implementation convenience: enforcement lives on-chain, in the token's own Transfer Hook program, rather than only in backend/off-chain logic, because on-chain, token-level enforcement is what would need to be proven before a real institution trusted this pattern in production. See Technical approach for how the sanctions check honors this without requiring the hook to make a live network call (which no on-chain program, on any chain, can do).

## Redeem/burn flow

1. A redemption request (trigger mechanism not yet specified — see Open questions) initiates the flow for a given client and amount.
2. The system issues a `Burn`/`BurnChecked` instruction directly against the client's own token account — no intermediate transfer to a redemption/omnibus account is needed.
3. Before co-signing, the bank's redemption service checks the client's address against the same on-chain `SanctionsRegistry` PDA the Transfer Hook reads (see Technical approach) — the identical data source, just called directly by the redemption service rather than via the hook, since burn doesn't route through the hook. If the client is currently sanctioned, the redemption service refuses to co-sign; without that co-signature the burn instruction fails, blocking the redemption outright.
4. The mint is configured with the Permissioned Burn extension and a designated burn authority. `Burn`/`BurnChecked` requires that authority's co-signature; without it, the instruction fails outright. This is a direct, purpose-built compliance control — Solana's own documented rationale for the extension is literally "a tokenized asset that must stay backed 1:1" — rather than the indirect, convention-based guarantee a transfer-to-omnibus workaround would have relied on. Enforcement is the token program's own rule, not a discipline the redemption service has to uphold on its own.
5. Redemption doesn't run through the Transfer Hook's other per-transfer checks (Travel Rule, velocity) — those exist to govern value moving between two counterparties, which isn't what redemption is; a burn extinguishes the token back to cash rather than transferring it to anyone. The sanctions check is the one exception, re-applied directly per step 3: redemption is arguably the highest-value moment to catch a newly-sanctioned client, since it converts token value back into liquid fiat cash — checking only at onboarding and at ordinary transfer-time would leave this specific path open. This closes a gap identified during review, not an oversight in the original design. Beyond the sanctions re-check, the burn authority's co-sign step is itself the compliance gate for redemption: the bank's redemption service validates the request (e.g., against the ledger) before its co-signing key signs the burn.
6. Once the burn is confirmed, the client's segregated cash balance in the Postgres ledger is credited for the redeemed amount, and the "tokenized" tag from the fund/mint flow is released.

Sequencing gap: burn (on-chain) and ledger credit (Postgres) are still two separate, non-atomic operations. Ordering and failure handling (e.g., what happens if burn succeeds but the ledger credit fails) isn't designed yet. Flagged in Areas of concern.

## Reconciliation

Two invariants, not one:

1. **Aggregate check** — total tokens in circulation equals the total ledger balance marked as tokenized. Fast, cheap, early-warning signal.
2. **Per-client check** — each individual client's on-chain token balance (their ATA) matches their individually segregated cash-ledger claim in Postgres, checked client by client. This is the authoritative check: an aggregate match can hide a misallocation between two clients that happens to net to zero in aggregate but is wrong per-client (e.g., client A over-credited, client B under-credited by the same amount).

A reconciliation break is any mismatch surfaced by either check. Mechanically, this spec proposes a scheduled job that (a) sums all client ATA balances and compares to the ledger's total tokenized balance, and (b) iterates client by client comparing ATA balance to ledger balance, recording any per-client mismatch as a discrete break record (client ID, expected, actual, delta, timestamp). Check cadence (real-time per-event vs. periodic batch) and the alerting/notification path for a detected break are not yet decided — see Open questions.

## Token design

- **Standard:** Solana Token-2022 (Solana devnet, not mainnet).
- **Decimals:** 2, matching USD cents, so all amounts are handled as integers internally (e.g., $1,500,000.25 mints as the integer `150000025`), avoiding floating-point/decimal-convention rounding errors.
- **Extensions used:**
  - **Default Account State** — new accounts default to frozen; require explicit compliance-driven thaw before they can hold or move tokens (Layer 1 compliance, see Move/transfer flow).
  - **Permanent Delegate** — grants the bank a standing delegate right over all token accounts, for compliance recovery/clawback of a compromised or sanctioned account. Distinct from Permissioned Burn below: this is for exceptional recovery scenarios, not the routine redemption path.
  - **Required Memo** — mandates a memo on every transfer, used to carry the Travel Rule originator/recipient payload.
  - **Transfer Hook** — points at the custom Anchor program that enforces the four transfer-time checks (Layer 2 compliance, see Move/transfer flow).
  - **Permissioned Burn** — designates a burn authority whose co-signature is required on every `Burn`/`BurnChecked` instruction; the standard burn path fails without it. This is the mechanism that keeps redemption compliance-gated at the token level (see Redeem/burn flow).
- **Per-client velocity account** — a compliance-writable on-chain account per client, storing their risk rating (low/medium/high), a running velocity total, and a window-start timestamp. Initialized at onboarding alongside the Default Account State thaw; read (and updated) by the Transfer Hook on every transfer (see Move/transfer flow, check 1).
- **Sanctions registry PDA** — a single on-chain account holding a periodically-synced snapshot of Solana-format addresses drawn from OFAC's SDN list; read by the Transfer Hook on every transfer (see Technical approach for the sync mechanism).
- **Authority model:** mint authority, freeze authority, permanent delegate authority, burn authority (Permissioned Burn), and the sanctions-registry sync authority are all bank-controlled. The specific custody arrangement (single key vs. multisig, which service holds which authority) is not yet defined — see Open questions.

## Technical approach

- **Chain:** Solana devnet.
- **Token program:** Token-2022, with the extensions above.
- **Transfer Hook program:** Rust/Anchor, deployed to devnet, implementing the four checks in Move/transfer flow.
- **Core ledger:** mocked as a Postgres table (or small set of tables) representing segregated per-client cash balances — the system's sole legal source of truth.
- **Deposit trigger:** a simulated event feed (not manual entry) emits synthetic deposit notifications that drive the fund/mint flow.
- **Sanctions registry sync:** no on-chain program, on Solana or any other chain, can make a live network call during its execution — this is a universal constraint, not a Solana-specific gap. The fix is the same pattern the previous project validated with the Chainalysis oracle: an off-chain sync process, running on a fixed daily cadence, fetches the public OFAC SDN list, filters it down to entries formatted as Solana-shaped addresses (base58-encoded 32-byte pubkeys, pulled from the SDN list's digital-currency-address fields), and writes that filtered set into a single on-chain `SanctionsRegistry` PDA. Only the sync authority's signature (a bank-controlled off-chain service keypair, distinct from mint/freeze/burn authorities) can update the PDA's contents. The Transfer Hook only ever reads it — a fast, ordinary on-chain account read at transfer time, never a live call to OFAC or any external service. Because Solana-format addresses are a small, likely near-empty subset of the full SDN list, the filtered on-chain set stays small enough to read cheaply within the hook's compute budget.
- **Off-chain indexer:** a service that listens for on-chain program logs/events from the Transfer Hook (large-transaction flags, blocked-transfer reasons) and records them off-chain for compliance/ops visibility, since the hook itself cannot write anywhere but the chain.
- **Reconciliation job:** a scheduled off-chain process implementing the two invariants above, reading both the Postgres ledger and on-chain token account balances.

## Areas of concern

These are gaps that could block implementation without a follow-up decision:

- **No cross-system atomicity between Postgres and Solana.** Both fund/mint and redeem/burn involve a ledger write and an on-chain instruction as two separate, non-atomic steps. Neither ordering nor compensation/retry logic for a partial failure (one side succeeds, the other doesn't) is defined. This is precisely the failure mode reconciliation is designed to detect, but detection isn't prevention — a partial failure would sit as an open break until the next reconciliation run.
- **Authority/key custody undefined.** Mint authority, freeze authority, permanent delegate authority, burn authority, and the sanctions-registry sync authority are all bank-controlled per Token design, but the actual custody model (single key, multisig, which service/process holds each one, how thaw/burn/clawback/registry-update actions get authorized) isn't specified.
- **Client key custody is bank-side for this POC — a deliberate scope decision, not an oversight.** Simulated clients have no independent external wallet; the backend custodies each client's token-account signing key alongside the bank's own authority keys, so every flow can be driven end-to-end by clicking through the demo UI without a separate per-client wallet/signing experience. This is a real simplification relative to how a production deposit-token system would work — e.g. JPM Coin's actual model has the client control their own key via a client-side framework, not the issuing bank custodying it invisibly. Reintroducing client-side custody (a signing UX distinct from the bank's own authority keys) is deferred, not designed here.

## Open questions

- **Cross-system atomicity** — see Areas of concern; no ordering or compensation logic yet for a partial failure between the Postgres ledger and Solana on either the mint or burn path.
- **Redemption trigger** — is the redemption request simulated the same way the deposit event is (per the intent doc's resolved decision), or does it originate differently (e.g., an explicit API call standing in for a client instruction)?
- **Reconciliation cadence** — real-time per-event, or periodic batch (and if batch, what interval)?
- **Reconciliation break routing** — who or what receives a break alert (ops, compliance, both), and in what form (dashboard, log, paging)?
- **Authority/key custody model** — see Areas of concern; needs a decision before deployment scripting, though it may be reasonable to defer with a placeholder single-key setup for the POC specifically.
