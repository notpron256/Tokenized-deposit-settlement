import { useEffect, useState } from "react";
import {
  runReconciliation,
  listReconciliationBreaks,
  type ReconciliationRunResult,
  type ReconciliationBreakRecord,
} from "../lib/api";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function Reconciliation() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ReconciliationRunResult | null>(null);

  const [history, setHistory] = useState<ReconciliationBreakRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  function refreshHistory() {
    setHistoryLoading(true);
    listReconciliationBreaks()
      .then(setHistory)
      .catch((err) => setHistoryError(err instanceof Error ? err.message : String(err)))
      .finally(() => setHistoryLoading(false));
  }

  useEffect(() => {
    refreshHistory();
  }, []);

  async function handleRun() {
    setRunning(true);
    setError(null);
    setLastRun(null);
    try {
      const result = await runReconciliation();
      setLastRun(result);
      refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="reconciliation-page">
      <h2>Reconciliation</h2>
      <p className="kyc-disclaimer">
        Two invariants (spec-001.md): an <strong>aggregate</strong> check (the mint's own on-chain supply vs. the sum
        of every client's <span className="mono-cell">tokenized_cents</span>) and the authoritative{" "}
        <strong>per-client</strong> check (each client's real on-chain ATA balance vs. their own{" "}
        <span className="mono-cell">tokenized_cents</span>) — an aggregate match alone can hide two clients' errors
        netting to zero. On-chain balances are read fresh, directly from the chain, never from this backend's own
        transfer/fund/clawback/redeem bookkeeping. A break that exactly matches a confirmed-but-not-yet-settled
        event for that client is labeled <strong>in_flight</strong> (the chain action already happened, Postgres
        just hasn't caught up) rather than treated as a genuine data-integrity error.
      </p>

      <button type="button" onClick={handleRun} disabled={running}>
        {running ? "Running…" : "Run Reconciliation"}
      </button>

      {error && <p className="status-message status-error">{error}</p>}

      {lastRun && (
        <div className={lastRun.allClear ? "status-message status-success" : "status-message status-error"}>
          <p>
            Ran at {new Date(lastRun.ranAt).toLocaleString()} — {lastRun.clientsChecked} client(s) checked. Aggregate:
            expected {formatCents(lastRun.aggregateExpectedCents)}, actual (on-chain mint supply){" "}
            {formatCents(lastRun.aggregateActualCents)}.
          </p>
          {lastRun.allClear ? (
            <p>All clear — no breaks detected.</p>
          ) : (
            <>
              <p>
                <strong>
                  {lastRun.breaks.length} break{lastRun.breaks.length === 1 ? "" : "s"} detected:
                </strong>
              </p>
              <ul>
                {lastRun.breaks.map((b, i) => (
                  <li key={i}>
                    [{b.breakType}] {b.clientName ?? "aggregate"} — expected {formatCents(b.expectedCents)}, actual{" "}
                    {formatCents(b.actualCents)}, delta {formatCents(b.deltaCents)} —{" "}
                    <span className={b.classification === "in_flight" ? "source-badge source-synthetic" : "source-badge source-real"}>
                      {b.classification === "in_flight" ? "IN-FLIGHT (timing artifact)" : "UNEXPLAINED"}
                    </span>
                    {b.note && <div className="field-hint">{b.note}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <h3>Break history</h3>
      {historyError && <p className="status-message status-error">{historyError}</p>}
      {historyLoading ? (
        <p>Loading…</p>
      ) : history.length === 0 ? (
        <p>No breaks recorded yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="clients-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Client</th>
                <th>Expected</th>
                <th>Actual</th>
                <th>Delta</th>
                <th>Classification</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.id}>
                  <td>{b.breakType}</td>
                  <td>{b.clientName ?? <span className="field-hint">aggregate</span>}</td>
                  <td>{formatCents(b.expectedCents)}</td>
                  <td>{formatCents(b.actualCents)}</td>
                  <td>{formatCents(b.deltaCents)}</td>
                  <td>
                    <span className={b.classification === "in_flight" ? "source-badge source-synthetic" : "source-badge source-real"}>
                      {b.classification}
                    </span>
                  </td>
                  <td>{new Date(b.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
