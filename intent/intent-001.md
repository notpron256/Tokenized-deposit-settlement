# Intent 001: Tokenized Deposit Settlement

Author: Sebastian Higgs
Status: Draft

## Problem

Cross-border and correspondent-banking money movement is slow and operationally fragmented even though messaging (SWIFT) is instant — actual value settlement, reconciliation, and record-matching happen as separate, delayed steps, often across multiple systems and multiple correspondent banks in a payment chain. This creates trapped liquidity (nostro/vostro prefunding held idle at multiple correspondents to be ready for payments), ties up working capital, creates counterparty settlement risk (e.g. delayed margin/collateral movement), and is constrained by market cut-off times that prevent true 24/7 movement. Correspondent banking chains also carry elevated compliance risk, historically causing some banking corridors to be treated as high-risk or avoided entirely.

## Proposed outcome

A tokenized deposit system, modeled on the deposit-token category pioneered by products like JPM Coin (not a stablecoin or cryptocurrency — a bank-backed digital representation of a real deposit liability). An institutional client deposits cash, which mints an equivalent tokenized deposit; the token can move 24/7 between KYC'd, onboarded counterparties with compliance controls enforced at the token level; the token can be redeemed back to cash on demand, burning the token and crediting the depositor's cash balance. This collapses payment, settlement, and reconciliation into a single on-chain action instead of three separate delayed steps.

## Affected users and systems

- Institutional clients depositing/redeeming.
- Treasury/liquidity management deciding fund vs. redeem timing.
- Operations/reconciliation teams, whose job shifts from manual cross-system matching to verifying continuous on-chain/ledger sync.
- Compliance/risk, needing assurance mint/burn always matches real ledger movement and only onboarded counterparties can hold/move tokens.
- Systems: a core banking ledger (the legal source of truth for the deposit liability) and the Solana blockchain (Token-2022 program) holding the token representation — the system reads AND writes to the ledger (deposit triggers mint, redemption request triggers burn-and-credit).

## Design principles

- The bank's core ledger remains the sole legal source of truth for the deposit liability at all times — this project does not attempt to make the blockchain the source of truth, only a synchronized, verifiable representation of it. This is an explicit axiom, not a compromise.
- Token-level compliance, not network-level: built on Solana's Token-2022 standard using native extensions (Default Account State so new accounts start frozen until KYC-approved, Permanent Delegate for compliance recovery/clawback, Required Memo to carry FATF/FinCEN Travel Rule originator-recipient data on every transfer) rather than a private/permissioned chain — mirroring how JPM Coin operates on a public chain (Base) with allowlisted counterparties rather than a fully private ledger.
- Event-driven mint/burn: a real deposit event triggers mint, a redemption request triggers burn and ledger credit — symmetric to how the prior project's screening tool subscribed to wallet events rather than independently monitoring the chain.

## Constraints

- Solana devnet, not mainnet — this models bank liability tokens, and using real mainnet value for a fake deposit liability is the wrong thing to make real, unlike some real-money elements in the previous project.
- No real core banking system access — a mock internal ledger (e.g. a Postgres table of client cash balances) stands in for one, the same way a previous project mocked wallet-adjacent flows.
- No real regulatory approval or affiliation with any named bank or product (not JPM Coin, not affiliated with JPMorgan) — this is a functional, generic model of the deposit-token category, not a copy of a named product.

## Open questions

- Should the Transfer Hook extension (custom per-transfer allowlist program) be implemented, or does Default Account State (frozen-until-approved accounts) alone sufficiently enforce the KYC-gating requirement for a POC?
- What triggers "deposit received" in the absence of a real core banking system — manual entry (mirroring the previous project's manual-entry pattern) or a simulated event feed?
- What does a reconciliation break (token supply vs. ledger-backed balance mismatch) actually look like as a detectable, provable event, and who should see it?
