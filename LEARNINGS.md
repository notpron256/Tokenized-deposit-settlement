# Technical Learnings: Building a Tokenized Deposit System on Solana

This is a synthesis of what this project actually found while building a working tokenized deposit proof of concept on Solana — Token-2022, the Transfer Hook interface, local vs. real-network tooling, RPC infrastructure, off-chain indexing, and reconciliation design — plus what generalizes from those findings to tokenized deposits and other real-world assets (RWAs) more broadly.

Every claim below is grounded in something this project actually did: a real transaction, a real error, a real number pulled from the chain or the code, not something read in documentation and repeated. Where a finding came from a real incident, the incident is named. The full build (code, on-chain programs, design docs) is public: [github.com/notpron256/tokenized-deposit-settlement](https://github.com/notpron256/tokenized-deposit-settlement).

---

## 1. Token-2022 extensions: what's genuinely native, and what you still build yourself

Token-2022's pitch is "compliance primitives as protocol features, not custom contract code." That's real, but it's narrower than it sounds, and the boundary matters for anyone estimating build cost.

**Genuinely native — a mint/account property, zero custom logic:**
- **Default Account State** — set an account frozen-by-default at the mint level. A new client's token account is unusable the instant it's created, until compliance explicitly thaws it. This is enforced by the shared Token-2022 program itself, not application code — no path exists to move tokens from a frozen account regardless of what calls the transfer.
- **Permanent Delegate** — a standing, mint-configured authority that can transfer or burn from *any* account under that mint without that account's own signature. This is what powers a clean compliance clawback (a sanctions hit, a court order, a fraud investigation) as a first-class, documented mechanism rather than a bespoke backdoor. Used successfully here since the mint was first created, on both local and real devnet, without any deployment gap.
- **Transfer Hook — the interface, specifically.** The base token program guarantees it will invoke a configured hook program on every transfer, with no way to route around it. That guarantee is native and genuinely valuable: the highest-attack-surface code (actually moving tokens safely) is handled by infrastructure every Token-2022 token relies on and that has been independently scrutinized, not code this project wrote and fully owns the risk of.

**Not native — real custom code, running inside that hook:**
- The velocity limit, the Travel Rule memo shape and validation, the sanctions-registry lookup, and the large-transaction flag are **100% custom Rust**, written for this project (`programs/compliance-hook/src/lib.rs`). Token-2022 gives you the guarantee that this logic *runs* and *can't be bypassed* — it does not give you the compliance logic itself. Anyone scoping a similar build should budget real engineering time for this layer; "Solana has native compliance" is true of the enforcement point, not the rules.

**A genuine platform-vs-tooling gap, found and independently confirmed both ways.** `PermissionedBurn` — an extension documented for exactly the "asset must stay backed 1:1" use case a tokenized deposit is — was rejected by the locally-deployed Token-2022 build during early spiking (`Invalid instruction`, custom program error `0xc`). That result drove building a custom two-party (client + compliance officer) co-signed redemption-gateway program instead, rather than the single-authority `PermissionedBurn` mechanism. Later, specifically to check whether that result generalized, the same instruction was sent as a **real transaction against real devnet** (confirmed, and independently verifiable on a public explorer: `E94YjZvFWxxcjcRKzbbowT9c8hzUjqaiMpoTnFcrXydKicpNn7yhkdnKjjGGCHAAfCSseovxJRHgqcRR4xjBHLf`) and **simulated against real mainnet-beta** (`err: null`, program logs showing `Instruction: PermissionedBurnExtension` / `PermissionedBurnInstruction::Initialize` both succeeding) — both confirmed the extension **is** supported on real infrastructure. `solana-test-validator`'s genesis-baked Token-2022 build is frozen at whatever version shipped with that specific CLI release and does not self-update; it had simply fallen behind. See §3 below — this is a specific instance of a general risk, not a one-off.

**A nuance worth being explicit about, even having confirmed `PermissionedBurn` works:** it and the two-party co-sign mechanism actually built here are **not equivalent designs**, independent of the deployment question. `PermissionedBurn` expresses a *single* burn authority; the custom program expresses a genuine two-party joint authorization (client consent *and* compliance sign-off, both required in the same transaction). A team choosing between them should decide on the control model they actually want, not just on which is technically available.

---

## 2. The Transfer Hook interface: real power, one real sharp edge

The standard Transfer Hook interface identifies a transfer's authorizing party through a single account field, documented only as **"owner/delegate"** — it does not tell the integrator which of the two it is in a given call. That distinction is left entirely to whoever builds on top of it, and getting it wrong is easy because both cases compile and often work correctly for the common path.

**What actually happened:** this project's first implementation of the three blocking checks (velocity, Travel Rule memo, sanctions) all read that field as if it were always the transferring client. For an ordinary client-signed transfer, that's correct. For a Permanent-Delegate-authorized clawback, it's wrong — the signer is the bank's own delegate authority, not the client. The practical consequence was serious and specific: `check_sanctions` reading the *signer* instead of the real source-account owner meant a clawback out of an **actually-sanctioned account** passed the sanctions check undetected — the control meant to catch exactly that case was silently inverted for the one path where it mattered most. This was verified for real, on-chain, against a genuinely sanctioned test account's real balance, before any fix was written.

The fix was narrow and precise: detect when the signer matches the mint's own configured Permanent Delegate (read directly from the mint's own extension data, not hand-decoded) and exempt that specific path from all three blocking checks — a genuine exemption for a distinct authorization model, not a workaround. Re-verified via full regression: ordinary transfers still blocked correctly, an ordinary in-limits transfer still succeeded, a clawback from a sanctioned account now succeeded with the correct (non-Travel-Rule) memo shape, and the velocity check was provably never invoked for that path, not merely satisfied by coincidence.

**The generalizable point:** any team building an emergency/recovery authority (clawback, freeze, forced burn) on top of a shared interface like this should treat "does my code correctly distinguish the authority types this interface can present" as a required, explicit test case — not something the interface's own shape will guide you toward getting right.

---

## 3. Local test validator vs. real devnet/mainnet: a genuine parity risk, twice found

`solana-test-validator` is fast, free, and the right place for iterative development — this project used it that way for most of its build. But it is not a faithful stand-in for real network behavior in at least two concrete, empirically-found ways:

- **Program-version lag.** Its genesis-baked Token-2022 build is frozen at whatever shipped with the installed CLI tooling and does not self-update, unlike the continuously-upgraded programs on real devnet/mainnet. This produced a real false negative (`PermissionedBurn`, §1) that shaped a real architectural decision before the gap was caught.
- **Rent-cost parameters genuinely differ, not just observed cost.** `solana-test-validator`'s default genesis sets the `Rent` sysvar's `lamports_per_byte_year` to `6960`, against real devnet's live value of `5080` — a ~27% difference in rent-exemption cost for identical account sizes, verified by reading each cluster's `Rent` sysvar directly and independently reproduced by deploying the identical program binary to both (a ~0.73 cost ratio matching `5080/6960` almost exactly). Any cost planning based purely on local-validator numbers will overestimate real cost by roughly this ratio.
- **State is genuinely disposable, not just "fast to reset."** This project's local validator ledger, left running across the build, later became unrecoverable outright (`failed to load bank from snapshot ... account paths mismatching`) — a real, unrecoverable corruption of 12GB of accumulated local chain history, with no clean repair path. Local was retired as an actively maintained environment as a direct result; devnet became the sole ongoing environment. Local's convenience is real, but treating it as durable state is a mistake — plan around it being disposable from day one, not after losing it.

**The generalizable point:** anything claimed about platform *capability* — "does X extension work," "what does Y actually cost" — needs verification against the real, live network the product will actually run on, not against local simulation tooling, even when local behavior looks completely convincing on its own.

---

## 4. Public RPC infrastructure: real, load-bearing constraints — not a footnote

A free public RPC endpoint (`api.devnet.solana.com`) is adequate for development but imposes real constraints that shaped actual engineering decisions in this build, not just performance tuning:

- **Aggressive, bursty rate limiting.** Any workload issuing several `getTransaction`/`getSignaturesForAddress` calls back-to-back — an indexer backfill, a reconciliation scan — reliably hits `429 Too Many Requests`, sometimes even after a fixed throttle (300ms between calls) and several rounds of the client library's own built-in exponential backoff. This project ended up needing an *additional*, slower outer retry layer on top of the SDK's own retry behavior to reliably complete a ~40-signature scan.
- **`getProgramAccounts` is hard-blocked for high-traffic programs, regardless of filters.** Enumerating every token account for a specific mint under Token-2022 is the obvious approach — and it's refused outright by this public endpoint ("excluded from account secondary indexes"), confirmed with a `dataSize` filter included, not just a bare unfiltered call. The working alternative was scanning the *mint's own* signature history (`getSignaturesForAddress(mint)`, not the compliance program's) and reading `meta.pre/postTokenBalances` off each transaction — present on any transaction type, so it correctly captures mint/burn activity a hook-program-only scan would silently miss. This is a real, non-obvious engineering workaround any team building similar on-chain accounting tooling should expect to need.

**The generalizable point:** "free public RPC" is a development convenience, not a production dependency. A real deployment needs a dedicated RPC provider (or self-hosted infrastructure) as a genuine, budgeted line item — not something default tooling quietly absorbs — and any indexing/enumeration design should be built and tested against the *real* constraints of whatever RPC tier will actually be used, since the naive approach (`getProgramAccounts`) may simply not be available.

---

## 5. Off-chain indexing: necessary for compliance visibility, only as strong as its supervision

A public chain means transaction history is permanent and independently reconstructable — genuinely valuable, and this project relies on it directly: an off-chain indexer subscribes to the compliance program's on-chain activity live and durably reconstructs every real transfer purely from chain data, independent of anything the backend's own database claims happened. That independence is real and matters — an application-level bug in the primary system can't quietly corrupt this record too, because it isn't derived from the primary system at all.

**But "watches the chain" is only true while it's actually running, and this project found that gap for real, not hypothetically.** A genuine $40,000 devnet transfer went unindexed and unflagged for roughly an hour, discovered by chance rather than by any alert, because the indexer process had only ever been started for one-off verification runs and killed each time afterward — an entirely ordinary, easy-to-fall-into operational pattern during active development. The immediate fix (wiring it into `docker-compose.yml` so it starts automatically) closes the "did anyone remember to start it" failure mode, but deliberately does *not* add a restart policy or health-check supervision — meaning the same class of silent gap (a crash, a dropped RPC websocket subscription) remains a live, un-remediated risk today, by design, as a named POC-scope boundary rather than an oversight.

**The generalizable point:** independent on-chain reconstruction is a genuinely strong compliance-visibility pattern — and it is not a substitute for real process supervision (health checks, alerting on a detected gap, automatic restart). A production system needs both; this project only has the first, and says so explicitly.

---

## 6. Reconciliation design: the aggregate-check trap, and how it actually failed

Every institution reconciling a ledger against a second system of record needs to answer: does the total match, and does each individual position match. This project built both checks, and the *aggregate* one broke in an instructive, non-obvious way.

The original design compared the mint's real on-chain `supply` against the sum of only the clients *currently tracked in Postgres*, plus one known non-client holder (a bank recovery account). That design is sound only as long as every on-chain holder that has ever existed is still tracked in the ledger. It is not sound the moment that assumption is violated — and a routine operational action violated it directly: resetting the demo Postgres data for a clean environment (while correctly, deliberately leaving on-chain state untouched) meant every pre-reset client's real, unchanged on-chain balance instantly became invisible to the "expected" side of the check. The very next run reported a **$45,134,588.99 "unexplained" aggregate break** — a number that looked like a serious data-integrity failure and was, in fact, zero real risk: every dollar was a real, legitimate historical balance, correctly present on-chain, simply no longer tracked by a ledger that had been intentionally reset.

The fix generalizes: the check now sums **every real on-chain holder that has ever existed** (found via the mint's own transaction history, per §4) and compares that true total against supply — which reconciles by construction, since supply is definitionally the sum of every account's balance. The gap between that true total and what the ledger currently tracks is reported as a **separate, explicitly labeled, informational figure** ("N untracked holders, $X") — never written into the same "break" record a genuine data-integrity failure would produce.

**The generalizable point, stated precisely because it's easy to get backwards:** a reconciliation aggregate check is only as trustworthy as its definition of "expected." A design that defines "expected" as "what our own database currently tracks" will misfire the moment the database's tracked population and the chain's real population diverge for any legitimate reason (a reset, an offboarded client whose account wasn't closed, a migration) — and will do so in the most alarming way possible, a large unexplained-looking number, exactly when trust in the reconciliation process matters most. The more robust design compares against the chain's own ground truth directly, and treats "the ledger doesn't currently track this holder" as its own, separately-labeled category — never silently folded into "something is wrong."

---

## 7. Settlement finality: "confirmed" vs. "finalized" is a real design decision, not a technicality

Solana's consensus model offers a genuine speed-versus-certainty tradeoff, exposed as distinct commitment levels: "confirmed" (a supermajority has voted, reversal is extremely unlikely) arrives well before "finalized" (reversal would require an almost inconceivable coordinated failure). Building against "confirmed" is a normal, defensible default for most applications, given the latency benefit and genuinely tiny residual risk.

This project initially did exactly that — and it was a real bug, not a deliberate choice: every value-moving flow's ledger row was marked at its terminal, successful status the moment a transaction reached "confirmed," one step short of the network's strongest guarantee, discovered via an explicit audit rather than a failure in practice. For a system settling actual deposit liabilities, that residual risk — however small — is not the right tradeoff to make implicitly. The fix: every flow now waits for genuine "finalized" commitment before a ledger row is marked settled, at a real, measured cost of roughly 10–20 seconds per transaction.

**The generalizable point:** "Solana settles in under a second" is true of the network's raw confirmed-commitment speed. It is not automatically true of what a specific product should expose as *its own* settlement guarantee — that's a deliberate choice a team building on deposit-liability-grade infrastructure needs to make explicitly, the same way this project had to fix it after initially defaulting to the faster, less certain option.

---

## 8. Cost economics: real, measured numbers

Everything below was pulled directly from the chain, not estimated:

- **Per-transfer cost.** A real confirmed devnet transaction (two signatures) cost exactly **10,000 lamports (0.00001 SOL)** — at SOL ≈ $99.52 (spot price checked directly, Sept 2026), roughly **$0.001, a tenth of a cent**. Solana's fee is a flat per-signature cost, not a percentage of value moved — a $50 transfer and a $5 million transfer cost the same fraction of a cent.
- **Infrastructure deployment cost.** Querying the two deployed on-chain programs directly: the compliance Transfer Hook program currently holds **1.27872236 SOL** in rent-exempt balance, the redemption-gateway program **0.44856908 SOL** — 1.727 SOL combined, ≈ **$172 at spot price**, before smaller supporting accounts (the mint, per-client velocity PDAs, the sanctions registry). This is a real, currently-checkable number (`solana program show <id>`), not a one-time estimate — and it will drift with SOL's own price, which argues for treating the SOL-denominated figure as the durable fact and any USD conversion as a dated snapshot, not a fixed claim.

**The generalizable point:** for a same-currency, 24/7 payments product specifically, "the infrastructure itself is expensive" is not a credible objection at this cost scale — the real cost center for a production system is everything *around* the chain (RPC infrastructure, key custody, supervision, compliance engineering), not the chain itself.

---

## 9. Relevance to tokenized deposits and RWAs more broadly

Distilling the above into what should generalize past this one build:

1. **Compliance-as-protocol-feature is real, and it's specifically the enforcement guarantee that's valuable — not a shortcut on writing compliance logic.** The genuine platform advantage is that a bad actor with a valid key cannot route around your rules by skipping your backend, because the rules run inside the token's own transfer path. The rules themselves — velocity limits, Travel Rule data, sanctions screening — are custom code regardless of platform. Any RWA or deposit-token build should budget for that engineering work, not assume the platform provides it.
2. **A single ambiguous field in a widely-used interface can silently defeat multiple compliance controls at once, specifically on the authority paths teams test least.** The Transfer Hook owner/delegate finding (§2) isn't Solana-specific in spirit — it's a reminder that emergency/recovery authorities (the paths used rarely, under pressure, by a different kind of caller than the common case) deserve explicit, dedicated test coverage, not inherited coverage from the ordinary-transfer test suite.
3. **Platform capability claims need verification against the real, live network — documentation and local tooling can both mislead, in different directions.** This project found a capability that *appeared* unsupported locally but works on real infrastructure (§1, §3) — the opposite failure mode (something that works locally but not in production) is at least as plausible and arguably more dangerous, since it wouldn't be caught until a real deployment attempt. Either way, the fix is the same: verify directly, don't infer.
4. **A reconciliation or audit process is only proven once it's been shown to correctly handle a real, deliberately-introduced anomaly — and "correctly handle" includes not raising a false alarm on a legitimate operational event.** §6 is as much a finding about audit-system design generally as it is about this project specifically: an aggregate check that treats "not currently in our database" as synonymous with "wrong" will misfire on entirely ordinary events (an offboarded account, a data migration, an environment reset) in exactly the way that erodes trust in the alert the fastest.
5. **Independent, chain-derived monitoring needs the same operational discipline as any other production service — it does not inherit reliability from being "on-chain."** The indexer's independence from the primary ledger (§5) is a real structural strength; its lack of supervision is a real, separate weakness, and conflating "we watch the chain independently" with "we always know what's happening" is exactly the gap the $40,000 incident exposed.
6. **The unit economics genuinely are not the blocker for this category of product.** At fractions of a cent per transfer and low-hundreds-of-dollars one-time infrastructure cost, the strategic case for a same-currency, 24/7 tokenized deposit rail does not fail on "the technology is too expensive to run" — whatever else remains true about key custody, inter-institutional settlement standards, and legal review being genuinely unresolved elsewhere.
