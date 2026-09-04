import { useEffect, useState } from "react";
import {
  listTransferEvidence,
  getTransferEvidence,
  type TransferListItem,
  type TransferEvidence as TransferEvidenceData,
  type TransferPartyEvidence,
} from "../lib/api";
import CopyButton from "../components/CopyButton";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function explorerUrl(signature: string): string {
  const customUrl = encodeURIComponent("http://localhost:8899");
  return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${customUrl}`;
}

function PartyCard({ label, party }: { label: string; party: TransferPartyEvidence }) {
  return (
    <div className="evidence-party-card">
      <h4>{label}</h4>
      {!party.found ? (
        <p className="status-message status-error">
          No Postgres record found for reference ID <span className="mono-cell">{party.clientId}</span> — this
          client may have been removed since the transfer happened. Cannot verify.
        </p>
      ) : (
        <>
          <p className="evidence-identity-caption">This is what the reference ID and hash resolve to:</p>
          <dl className="evidence-fields">
            <dt>Legal name</dt>
            <dd>{party.name}</dd>
            <dt>Registration ID</dt>
            <dd>{party.registrationId}</dd>
            <dt>Legal address</dt>
            <dd>{party.legalAddress}</dd>
          </dl>
          <p className={party.match ? "evidence-verify-match" : "evidence-verify-mismatch"}>
            {party.match ? "✓ MATCH" : "✗ MISMATCH"} — recomputed hash from the current Postgres record{" "}
            {party.match ? "equals" : "does NOT equal"} the hash posted on-chain at transfer time.
          </p>
          <dl className="evidence-fields evidence-hashes">
            <dt>On-chain hash</dt>
            <dd className="mono-cell">{party.onChainHash}</dd>
            <dt>Recomputed just now</dt>
            <dd className="mono-cell">{party.recomputedHash}</dd>
          </dl>
        </>
      )}
    </div>
  );
}

export default function Evidence() {
  const [transfers, setTransfers] = useState<TransferListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<TransferListItem | null>(null);
  const [evidence, setEvidence] = useState<TransferEvidenceData | null>(null);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  async function refreshList() {
    setLoadingList(true);
    try {
      setTransfers(await listTransferEvidence());
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    refreshList();
  }, []);

  async function loadEvidence(signature: string) {
    setLoadingEvidence(true);
    setEvidenceError(null);
    try {
      // Always a fresh read: the on-chain memo comes straight from the
      // validator, and the hash comparison is recomputed from Postgres
      // right now — nothing here is cached from when the transfer happened.
      setEvidence(await getTransferEvidence(signature));
    } catch (err) {
      setEvidence(null);
      setEvidenceError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingEvidence(false);
    }
  }

  function openEvidence(item: TransferListItem) {
    setSelected(item);
    setEvidence(null);
    setEvidenceError(null);
    if (item.txSignature) loadEvidence(item.txSignature);
  }

  if (selected) {
    return (
      <div className="evidence-page">
        <button className="evidence-back" onClick={() => setSelected(null)}>
          ← Back to transfer list
        </button>
        <h2>Transaction Evidence</h2>
        <p className="kyc-disclaimer">
          This is an audit view, not a routine transaction detail screen: everything below is independently
          re-derived right now — the memo is read straight from the validator by signature (never from Postgres),
          and the identity hash is recomputed fresh from the current database record — so you can verify this
          transfer's Travel Rule compliance claim yourself, not just take the app's word for it.
        </p>

        <p>
          {selected.senderName} → {selected.recipientName}, {formatCents(selected.amountCents)}, status:{" "}
          {selected.status}
        </p>

        {!selected.txSignature && (
          <p className="status-message status-error">
            This transfer has no on-chain signature (status: {selected.status}) — nothing was ever broadcast, so
            there's no transaction to fetch evidence for.
          </p>
        )}

        {loadingEvidence && (
          <p className="status-message status-pending">
            <span className="status-pending-dot" aria-hidden="true" />
            Fetching the transaction fresh from the validator and recomputing identity hashes…
          </p>
        )}
        {evidenceError && (
          <p className="status-message status-error">
            {evidenceError}
            {selected.txSignature && (
              <>
                <br />
                <button className="evidence-retry" onClick={() => loadEvidence(selected.txSignature!)}>
                  Re-verify now
                </button>
              </>
            )}
          </p>
        )}

        {evidence && (
          <>
            <section className="evidence-section">
              <h3>1. Decoded on-chain memo</h3>
              <p className="evidence-identity-caption">
                Read directly from the transaction's Memo instruction on the validator — not parsed from a log
                line, not read from Postgres.
              </p>
              <div className="evidence-memo-raw mono-cell">{evidence.memo.raw}</div>
              <dl className="evidence-fields">
                <dt>:20: Transaction reference</dt>
                <dd>{evidence.memo.reference}</dd>
                <dt>:70: Remittance information</dt>
                <dd>{evidence.memo.remittance}</dd>
              </dl>
            </section>

            <section className="evidence-section">
              <h3>2 &amp; 3. Live integrity check + linked identity data</h3>
              <div className="evidence-parties">
                <PartyCard label=":50K: Ordering customer" party={evidence.ordering} />
                <PartyCard label=":59: Beneficiary customer" party={evidence.beneficiary} />
              </div>
              <button className="evidence-retry" onClick={() => loadEvidence(evidence.signature)}>
                Verify Integrity again
              </button>
            </section>

            <section className="evidence-section">
              <h3>4. Independent verification</h3>
              <p>
                Signature: <span className="mono-cell">{evidence.signature}</span>{" "}
                <CopyButton value={evidence.signature} />
              </p>
              <p>
                Slot {evidence.slot}
                {evidence.blockTime && ` — ${new Date(evidence.blockTime * 1000).toLocaleString()}`}
              </p>
              <p>
                <a href={explorerUrl(evidence.signature)} target="_blank" rel="noopener noreferrer">
                  Open in Solana Explorer (pointed at this local validator) →
                </a>
              </p>
              <p className="evidence-identity-caption">
                If that link doesn't load the transaction (some browsers block a public site from reaching
                localhost), do it manually: go to explorer.solana.com, open the cluster dropdown (top right), choose
                "Custom RPC URL", enter <span className="mono-cell">http://localhost:8899</span>, then paste the
                signature above into the search bar. Either way, this is Solana Explorer reading the validator
                directly — not this application reporting on itself.
              </p>
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="evidence-page">
      <h2>Transaction Evidence</h2>
      <p className="kyc-disclaimer">
        Click into any past transfer to see the full backing evidence for its Travel Rule compliance claim — the
        decoded on-chain memo, a live integrity check against Postgres, the real identity data it resolves to, and
        an independent Explorer lookup. Sourced from transfer_events, not from re-scanning chain history, so the
        list survives validator restarts even though very old signatures themselves may age out of this local
        validator's retained ledger history.
      </p>

      {listError && <p className="status-message status-error">{listError}</p>}
      {loadingList ? (
        <p>Loading…</p>
      ) : transfers.length === 0 ? (
        <p>No transfers yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="clients-table">
            <thead>
              <tr>
                <th>Ordering</th>
                <th>Beneficiary</th>
                <th>Amount</th>
                <th>Status</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td>{t.senderName}</td>
                  <td>{t.recipientName}</td>
                  <td>{formatCents(t.amountCents)}</td>
                  <td>{t.status}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                  <td>
                    {t.txSignature ? (
                      <button className="evidence-retry" onClick={() => openEvidence(t)}>
                        View evidence
                      </button>
                    ) : (
                      <span className="field-hint">no signature</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
