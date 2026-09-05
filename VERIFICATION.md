# Verification Runbook

Every claim this app's UI makes — a mint's compliance extensions, a client's
risk tier, a transfer's Travel Rule evidence, a "settled" status — is also
independently checkable from the command line, against the real Solana
validator and the real Postgres database, with no dependency on the
application's own backend or frontend code being correct or honest. This
document is that checklist: copy-pasteable commands, run against this repo's
actual running localhost environment, each with a one-line note on exactly
what it proves and why it doesn't require trusting the app's UI.

Every command below was run live against this repo's own environment while
writing this document — none are hypothetical.

## Prerequisites

```bash
# Solana CLI tools (solana, spl-token) — put on PATH for this shell session
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

RPC_URL=http://localhost:8899
MINT=$(cat backend/keys/mint-address.json | python3 -c "import json,sys; print(json.load(sys.stdin)['mint'])")

# Postgres — this project's own ledger, running in Docker. A function, not a
# plain string variable — "psql_query -t -A -c ..." doesn't reliably word-split
# in every shell, and silently fails with a confusing "command not found".
psql_query() {
  docker exec -i tokenized-deposit-settlement-postgres-1 psql -U deposit_poc -d deposit_poc "$@"
}
```

---

## 1. Confirm the mint's compliance extensions on-chain

**What this proves:** the mint genuinely has Default Account State (frozen
by default — the KYC gate), Permanent Delegate (bank clawback authority),
and a Transfer Hook pointed at the real deployed compliance program — not
placeholders, not something only the app's own code claims. `spl-token` is
Solana's own standard tooling, talking directly to the validator; it has no
awareness of this app's backend at all.

```bash
spl-token display "$MINT" --program-2022 --url "$RPC_URL"
```

Expect to see `Default state: Frozen`, a `Permanent delegate:` entry, and a
`Transfer Hook:` block whose `Program Id` matches the deployed compliance-hook
program (`9AxMnpb5g8c8DSnDHNYEeafiTrSzWZbthoDEQpTKiD5z`).

---

## 2. Read a client's actual token account state and balance

**What this proves:** the account's real on-chain balance, and that it
genuinely carries the `Transfer memo: Required` extension (the account-level
half of the Travel Rule enforcement) — read directly from the account's own
data, not from what the UI displays.

```bash
# Look up a client's ATA address directly in Postgres (or copy it from the
# Onboarding page) — this step alone doesn't prove anything on its own,
# it's just locating which account to inspect.
ATA=$(psql_query -t -A -c "SELECT ata_address FROM clients WHERE name = 'Settlement Test Corp';")

spl-token account-info --address "$ATA" --url "$RPC_URL"
```

The `Balance:` line is read straight from the account; compare it by eye
against whatever the app's UI shows for the same client — they should match,
but this command doesn't need the UI to be right to be trustworthy itself.

---

## 3. Read a client's risk tier directly from their velocity PDA

**What this proves:** the risk tier that actually gates their hourly
transfer cap is a real byte sitting in a real on-chain account, derived by
address (not looked up through the app), decoded by hand from the program's
own documented account layout — not a value the UI could show without it
actually being enforced on-chain.

```bash
cd backend
OWNER=$(psql_query -t -A -c "SELECT owner_address FROM clients WHERE name = 'Settlement Test Corp';")
npx tsx scripts/read-velocity-account.ts "$OWNER"
```

This derives the velocity PDA from the owner address using the same seeds
(`["velocity", owner]`) the compliance-hook program itself uses, fetches the
account, and decodes `risk_rating`, `running_total`, and `window_start`
directly from the raw account bytes at their documented offsets
(`programs/compliance-hook/src/state.rs`) — print the script itself if you
want to confirm there's no reliance on this app's own API anywhere in it.

---

## 4. Fetch a transaction by signature and decode its memo independently

**What this proves:** the Travel Rule memo actually posted on-chain for a
real transfer — read directly from the transaction, not from what the app's
Evidence view reports about it.

```bash
solana confirm -v <SIGNATURE> --url "$RPC_URL"
```

Look for the `Instruction 0` block whose `Program:` is the Memo program
(`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) — its `Data:` field is the
literal decoded memo text: `:20:<reference>|:50K:<clientId>:<hash>|:59:<clientId>:<hash>|:70:<remittance>`.
`solana confirm` is Solana's own CLI, not this project's code.

Independently of `solana confirm`'s own decoding, you can also confirm the
transaction's actual commitment level via a raw RPC call — this is the same
check section 6 below uses to prove settlement gating:

```bash
curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"getSignatureStatuses",
  "params":[["<SIGNATURE>"],{"searchTransactionHistory":true}]
}' | python3 -m json.tool
```

`confirmationStatus` will read `"finalized"` for anything more than a few
seconds old — this is Solana's own answer, not a status this app wrote
anywhere.

**Note on transaction history retention:** on this local validator, a
signature becomes unfetchable (`getTransaction` returns `null`) within a
few minutes — the ledger's retained history window is short in a local dev
environment (unlike a real Solana cluster, which retains this indefinitely).
If a signature from an old transfer doesn't resolve, that's this local
environment's retention limit, not evidence of a problem — generate a fresh
transfer (Transfer tab, or the `POST /transfers` example in section 6) and
verify against that instead.

---

## 5. Recompute an identity hash independently and compare to the on-chain value

**What this proves:** the SHA-256 identity commitment posted in a transfer's
memo is genuinely reproducible from nothing but the raw Postgres row and the
documented canonicalization rule — in a completely different language than
the app itself (Python, not TypeScript), using no code from this
repository's backend at all. If this matches, the on-chain hash provably
commits to real, unaltered data; it isn't a value only the app knows how to
produce or verify.

The canonicalization (`backend/src/solana/identityCommitment.ts`): for each
of `name`, `registration_id`, `legal_address`, in that order, prefix the
field's own UTF-8 byte length as `<n>:`, concatenate, then SHA-256 the
result and take the lowercase hex digest.

```bash
CLIENT_ID=$(psql_query -t -A -c "SELECT id FROM clients WHERE name = 'Settlement Test Corp';")

psql_query -t -A -c "SELECT name FROM clients WHERE id='$CLIENT_ID'" | tr -d '\n' > /tmp/name.bin
psql_query -t -A -c "SELECT registration_id FROM clients WHERE id='$CLIENT_ID'" | tr -d '\n' > /tmp/reg.bin
psql_query -t -A -c "SELECT legal_address FROM clients WHERE id='$CLIENT_ID'" | tr -d '\n' > /tmp/addr.bin

python3 -c "
import hashlib
buf = b''
for fname in ('/tmp/name.bin', '/tmp/reg.bin', '/tmp/addr.bin'):
    with open(fname, 'rb') as f:
        b = f.read()
    buf += f'{len(b)}:'.encode('utf-8') + b
print('Recomputed hash:', hashlib.sha256(buf).hexdigest())
"
rm /tmp/name.bin /tmp/reg.bin /tmp/addr.bin
```

Compare the printed hash against the `:50K:` or `:59:` field's hash half
(after the `:`) in a transfer memo decoded per section 4 where this client
was a party — or against the "On-chain hash" value shown in the app's own
Evidence view, which is the same comparison the app performs automatically
(`GET /transfers/:signature/evidence`) — this just proves you don't have to
take its word for it.

---

## 6. Verify a transfer's settlement was gated on "finalized," not "confirmed"

**What this proves:** the ledger genuinely does not mark a transfer
`settled` — the status every reconciliation/balance check trusts — until
Solana's own strongest commitment level is reached, not merely
`"confirmed"` (spec-001.md, Technical approach: "settled" vs "finalized").
This is the most direct check of the core axiom itself: watch, in real
time, that `transfer_events.status` sits at the intermediate `confirmed`
value for the entire ~15-20s finalization window, only moving to `settled`
once Solana's own RPC independently reports `"finalized"` for the same
signature.

Run this as one block — it starts a transfer in the background and polls
Postgres every second while it's in flight:

```bash
SENDER_ID=$(psql_query -t -A -c "SELECT id FROM clients WHERE name = 'Settlement Test Corp';")
RECIPIENT_ID=$(psql_query -t -A -c "SELECT id FROM clients WHERE name = 'Progress Indicator Check';")

(curl -s -X POST http://localhost:4100/transfers -H "Content-Type: application/json" \
  -d "{\"senderId\":\"$SENDER_ID\",\"recipientId\":\"$RECIPIENT_ID\",\"amountCents\":100,\"reference\":\"INV-VERIFY\",\"remittance\":\"Finality verification\"}" \
  -o /tmp/verify_result.json -w "\nHTTP %{http_code}\n") &

for i in $(seq 1 25); do
  ts=$(date +%H:%M:%S)
  row_status=$(psql_query -t -A -c "SELECT status FROM transfer_events ORDER BY created_at DESC LIMIT 1;")
  echo "$ts  transfer_events.status = $row_status"
  sleep 1
done
wait
cat /tmp/verify_result.json
```

Expect output like:

```
13:05:25  transfer_events.status = pending_chain
13:05:26  transfer_events.status = confirmed
13:05:27  transfer_events.status = confirmed
   ...  (stays at confirmed for ~15-20s — this is the window this whole
         check exists to prove: real value has moved on-chain, but the
         ledger correctly refuses to call it irrevocable yet)
13:05:39  transfer_events.status = confirmed
13:05:40  transfer_events.status = settled
{"signature":"...","senderCashBalanceCents":...,...}
```

Then confirm independently, via raw RPC (not this app), that `settled`
lines up with Solana's own `"finalized"` answer for that exact signature —
use the `<SIGNATURE>` from the JSON printed above:

```bash
curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"getSignatureStatuses",
  "params":[["<SIGNATURE>"],{"searchTransactionHistory":true}]
}' | python3 -m json.tool
```
