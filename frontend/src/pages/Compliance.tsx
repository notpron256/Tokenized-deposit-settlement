import { useEffect, useMemo, useState } from "react";
import {
  listComplianceFlags,
  listActivity,
  getSanctionsRegistry,
  type ComplianceFlag,
  type ActivityEntry,
  type SanctionsRegistryEntry,
} from "../lib/api";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

const ACTIVITY_PAGE_SIZE = 25;

export default function Compliance() {
  const [flags, setFlags] = useState<ComplianceFlag[]>([]);
  const [flagsLoading, setFlagsLoading] = useState(true);
  const [flagsError, setFlagsError] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [clientFilter, setClientFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [activityPage, setActivityPage] = useState(1);

  const [registryEntries, setRegistryEntries] = useState<SanctionsRegistryEntry[]>([]);
  const [registryNetwork, setRegistryNetwork] = useState<"local" | "devnet" | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);

  useEffect(() => {
    listComplianceFlags()
      .then(setFlags)
      .catch((err) => setFlagsError(err instanceof Error ? err.message : String(err)))
      .finally(() => setFlagsLoading(false));

    listActivity()
      .then(setActivity)
      .catch((err) => setActivityError(err instanceof Error ? err.message : String(err)))
      .finally(() => setActivityLoading(false));

    getSanctionsRegistry()
      .then((res) => {
        setRegistryEntries(res.entries);
        setRegistryNetwork(res.network);
      })
      .catch((err) => setRegistryError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRegistryLoading(false));
  }, []);

  const clientOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of activity) {
      if (entry.orderingName) names.add(entry.orderingName);
      if (entry.beneficiaryName) names.add(entry.beneficiaryName);
    }
    return Array.from(names).sort();
  }, [activity]);

  const filteredActivity = useMemo(() => {
    const from = fromDate ? new Date(fromDate) : null;
    // toDate is a plain yyyy-mm-dd value from a date input; add a day so the
    // filter reads as "through the end of this day", not midnight at its start.
    const to = toDate ? new Date(new Date(toDate).getTime() + 24 * 60 * 60 * 1000) : null;

    return activity.filter((entry) => {
      if (clientFilter && entry.orderingName !== clientFilter && entry.beneficiaryName !== clientFilter) {
        return false;
      }
      if (entry.blockTime && (from || to)) {
        const when = new Date(entry.blockTime);
        if (from && when < from) return false;
        if (to && when > to) return false;
      }
      return true;
    });
  }, [activity, clientFilter, fromDate, toDate]);

  // Pagination applies after filtering, over whatever the filters left —
  // narrowing the set first, then paging what's left, not the other way
  // around. Reset to page 1 whenever the filtered set changes so a filter
  // change never leaves the view stranded on a now out-of-range page.
  useEffect(() => {
    setActivityPage(1);
  }, [clientFilter, fromDate, toDate]);

  const activityPageCount = Math.max(1, Math.ceil(filteredActivity.length / ACTIVITY_PAGE_SIZE));
  const currentActivityPage = Math.min(activityPage, activityPageCount);
  const pagedActivity = filteredActivity.slice(
    (currentActivityPage - 1) * ACTIVITY_PAGE_SIZE,
    currentActivityPage * ACTIVITY_PAGE_SIZE,
  );

  return (
    <div className="compliance-page">
      <h2>Compliance</h2>

      <section className="compliance-section">
        <h3>Large-transaction flags</h3>
        <p className="kyc-disclaimer">
          Sourced from <span className="mono-cell">indexed_transfers</span> — Phase 6's off-chain indexer, which
          reconstructs this purely from on-chain program logs and token balance deltas. This is independent of the
          backend's own transfer bookkeeping: nothing here is read from <span className="mono-cell">transfer_events</span>.
        </p>
        {flagsError && <p className="status-message status-error">{flagsError}</p>}
        {flagsLoading ? (
          <p>Loading…</p>
        ) : flags.length === 0 ? (
          <p>No large-transaction flags indexed yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="clients-table">
              <thead>
                <tr>
                  <th>Ordering</th>
                  <th>Beneficiary</th>
                  <th>Amount</th>
                  <th>Reference</th>
                  <th>When</th>
                  <th>Signature</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr key={f.txSignature}>
                    <td>{f.orderingName ?? <span className="mono-cell">{shortAddress(f.senderOwner)}</span>}</td>
                    <td>{f.beneficiaryName ?? <span className="mono-cell">{shortAddress(f.recipientOwner)}</span>}</td>
                    <td>{formatCents(f.amountCents)}</td>
                    <td>{f.memoReference ?? <span className="field-hint">none</span>}</td>
                    <td>{f.blockTime ? new Date(f.blockTime).toLocaleString() : <span className="field-hint">unknown</span>}</td>
                    <td className="mono-cell">{shortAddress(f.txSignature)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="compliance-section">
        <h3>Sanctions registry {registryNetwork && <span className="field-hint">({registryNetwork})</span>}</h3>
        <p className="kyc-disclaimer">
          Read fresh from the on-chain SanctionsRegistry PDA on every load — never cached or hand-maintained in this
          UI. Each entry's badge comes directly from its own on-chain <span className="mono-cell">source</span>{" "}
          field, the same honesty labeling used elsewhere in this project: a REAL badge means real OFAC SDN data, a
          SYNTHETIC badge means a deliberately seeded test entry.
        </p>
        {registryError && <p className="status-message status-error">{registryError}</p>}
        {registryLoading ? (
          <p>Loading…</p>
        ) : registryEntries.length === 0 ? (
          <p>Registry is empty.</p>
        ) : (
          <div className="table-scroll">
            <table className="clients-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Client</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {registryEntries.map((e) => (
                  <tr key={e.address}>
                    <td className="mono-cell">{e.address}</td>
                    <td>{e.clientName ?? <span className="field-hint">no matching client on this network</span>}</td>
                    <td>
                      <span className={e.source === 0 ? "source-badge source-real" : "source-badge source-synthetic"}>
                        {e.sourceLabel}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="compliance-section">
        <h3>Activity history</h3>
        <p className="kyc-disclaimer">
          Every settled transfer captured by the indexer — same source as the flag list above (
          <span className="mono-cell">indexed_transfers</span>, never <span className="mono-cell">transfer_events</span>
          ), just unfiltered. Flagged transfers are marked inline rather than requiring a separate view to notice.
        </p>
        {activityError && <p className="status-message status-error">{activityError}</p>}
        {!activityLoading && activity.length > 0 && (
          <div className="activity-filters">
            <label>
              Client
              <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
                <option value="">All clients</option>
                {clientOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              From
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
            {(clientFilter || fromDate || toDate) && (
              <button
                type="button"
                className="evidence-retry"
                onClick={() => {
                  setClientFilter("");
                  setFromDate("");
                  setToDate("");
                }}
              >
                Clear filters
              </button>
            )}
            <span className="field-hint">
              Showing {filteredActivity.length} of {activity.length}
            </span>
          </div>
        )}
        {activityLoading ? (
          <p>Loading…</p>
        ) : activity.length === 0 ? (
          <p>No transfers indexed yet.</p>
        ) : filteredActivity.length === 0 ? (
          <p>No transfers match the current filters.</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="clients-table">
                <thead>
                  <tr>
                    <th>Ordering</th>
                    <th>Beneficiary</th>
                    <th>Amount</th>
                    <th>When</th>
                    <th>Flagged</th>
                    <th>Signature</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedActivity.map((entry) => (
                    <tr key={entry.txSignature} className={entry.largeTransactionFlag ? "activity-row-flagged" : undefined}>
                      <td>{entry.orderingName ?? <span className="mono-cell">{shortAddress(entry.senderOwner)}</span>}</td>
                      <td>{entry.beneficiaryName ?? <span className="mono-cell">{shortAddress(entry.recipientOwner)}</span>}</td>
                      <td>{formatCents(entry.amountCents)}</td>
                      <td>
                        {entry.blockTime ? new Date(entry.blockTime).toLocaleString() : <span className="field-hint">unknown</span>}
                      </td>
                      <td>
                        {entry.largeTransactionFlag ? (
                          <span className="source-badge source-real">LARGE</span>
                        ) : (
                          <span className="field-hint">—</span>
                        )}
                      </td>
                      <td className="mono-cell">{shortAddress(entry.txSignature)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {activityPageCount > 1 && (
              <div className="activity-pagination">
                <button
                  type="button"
                  className="evidence-retry"
                  disabled={currentActivityPage === 1}
                  onClick={() => setActivityPage((p) => Math.max(1, p - 1))}
                >
                  ← Previous
                </button>
                <span className="field-hint">
                  Page {currentActivityPage} of {activityPageCount}
                </span>
                <button
                  type="button"
                  className="evidence-retry"
                  disabled={currentActivityPage === activityPageCount}
                  onClick={() => setActivityPage((p) => Math.min(activityPageCount, p + 1))}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
