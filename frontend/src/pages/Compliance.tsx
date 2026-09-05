import { useEffect, useState } from "react";
import {
  listComplianceFlags,
  getSanctionsRegistry,
  type ComplianceFlag,
  type SanctionsRegistryEntry,
} from "../lib/api";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export default function Compliance() {
  const [flags, setFlags] = useState<ComplianceFlag[]>([]);
  const [flagsLoading, setFlagsLoading] = useState(true);
  const [flagsError, setFlagsError] = useState<string | null>(null);

  const [registryEntries, setRegistryEntries] = useState<SanctionsRegistryEntry[]>([]);
  const [registryNetwork, setRegistryNetwork] = useState<"local" | "devnet" | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [registryError, setRegistryError] = useState<string | null>(null);

  useEffect(() => {
    listComplianceFlags()
      .then(setFlags)
      .catch((err) => setFlagsError(err instanceof Error ? err.message : String(err)))
      .finally(() => setFlagsLoading(false));

    getSanctionsRegistry()
      .then((res) => {
        setRegistryEntries(res.entries);
        setRegistryNetwork(res.network);
      })
      .catch((err) => setRegistryError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRegistryLoading(false));
  }, []);

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
    </div>
  );
}
