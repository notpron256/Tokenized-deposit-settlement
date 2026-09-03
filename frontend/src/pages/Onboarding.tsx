import { useEffect, useState } from "react";
import { listClients, onboardClient, type Client } from "../lib/api";
import CopyButton from "../components/CopyButton";

const RISK_OPTIONS = [
  { value: 0, label: "Low ($5,000,000.00/hr cap)" },
  { value: 1, label: "Medium ($2,000,000.00/hr cap)" },
  { value: 2, label: "High ($500,000.00/hr cap)" },
] as const;

const RISK_BADGE: Record<string, string> = {
  low: "risk-badge risk-low",
  medium: "risk-badge risk-medium",
  high: "risk-badge risk-high",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// PREFIX-YYYY-NNNN, e.g. CASE-2026-0417. Keep in sync with the backend's
// copy of this pattern (backend/src/routes/onboarding.ts). Enforces a
// plausible case/ticket-ID shape only — see the disclaimer below the form;
// this is never checked against a real KYC system.
const KYC_REFERENCE_PATTERN = /^[A-Z]+-\d{4}-\d{3,6}$/;

export default function Onboarding() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [name, setName] = useState("");
  const [riskRating, setRiskRating] = useState<number>(0);
  const [kycReference, setKycReference] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [legalAddress, setLegalAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    name: string;
    status: string;
    riskLabel: string;
    ataAddress: string;
    kycReference: string;
  } | null>(null);

  async function refreshClients() {
    setLoadingClients(true);
    try {
      setClients(await listClients());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingClients(false);
    }
  }

  useEffect(() => {
    refreshClients();
  }, []);

  const kycReferenceValid = KYC_REFERENCE_PATTERN.test(kycReference.trim());
  const registrationIdValid = registrationId.trim().length > 0;
  const legalAddressValid = legalAddress.trim().length > 0;
  const nameValid = name.trim().length > 0;
  const canSubmit = !submitting && nameValid && kycReferenceValid && registrationIdValid && legalAddressValid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setLastResult(null);
    try {
      const result = await onboardClient(
        name.trim(),
        riskRating,
        kycReference.trim(),
        registrationId.trim(),
        legalAddress.trim(),
      );
      setLastResult({
        name: result.name,
        status: result.status,
        riskLabel: result.riskLabel,
        ataAddress: result.ataAddress,
        kycReference: result.kycReference,
      });
      setName("");
      setRiskRating(0);
      setKycReference("");
      setRegistrationId("");
      setLegalAddress("");
      await refreshClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="onboarding-page">
      <form onSubmit={handleSubmit} className="onboarding-form">
        <label>
          Client name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Corp Treasury"
            disabled={submitting}
            required
          />
          <span className="field-hint field-hint-spacer" aria-hidden="true">&nbsp;</span>
        </label>
        <label>
          Risk rating
          <select
            value={riskRating}
            onChange={(e) => setRiskRating(Number(e.target.value))}
            disabled={submitting}
          >
            {RISK_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="field-hint field-hint-spacer" aria-hidden="true">&nbsp;</span>
        </label>
        <label>
          KYC reference
          <input
            type="text"
            value={kycReference}
            onChange={(e) => setKycReference(e.target.value.toUpperCase())}
            placeholder="CASE-2026-0417"
            pattern={KYC_REFERENCE_PATTERN.source}
            title="Format: PREFIX-YYYY-NNNN, e.g. CASE-2026-0417"
            className={kycReference.length > 0 && !kycReferenceValid ? "input-invalid" : undefined}
            disabled={submitting}
            required
          />
          <span className="field-hint">Format: PREFIX-YYYY-NNNN, e.g. CASE-2026-0417</span>
        </label>
        <label>
          Registration ID
          <input
            type="text"
            value={registrationId}
            onChange={(e) => setRegistrationId(e.target.value)}
            placeholder="LEI-549300ABCDEFGHIJ1234"
            className={registrationId.length > 0 && !registrationIdValid ? "input-invalid" : undefined}
            disabled={submitting}
            required
          />
          <span className="field-hint">Resolved by reference into the Travel Rule memo — never posted on-chain in cleartext.</span>
        </label>
        <label>
          Legal address
          <input
            type="text"
            value={legalAddress}
            onChange={(e) => setLegalAddress(e.target.value)}
            placeholder="1 Wall Street, New York, NY 10005, USA"
            className={legalAddress.length > 0 && !legalAddressValid ? "input-invalid" : undefined}
            disabled={submitting}
            required
          />
          <span className="field-hint">Resolved by reference into the Travel Rule memo — never posted on-chain in cleartext.</span>
        </label>
        <div className="submit-field">
          <span className="field-label-spacer" aria-hidden="true">&nbsp;</span>
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Onboarding…" : "Onboard Client"}
          </button>
          <span className="field-hint field-hint-spacer" aria-hidden="true">&nbsp;</span>
        </div>
      </form>

      <p className="kyc-disclaimer">
        KYC reference is not independently verified against a real system in this POC — it is not checked, looked up,
        or validated anywhere. It only records where the operator claims real KYC and risk-rating approval happened
        out-of-band, as a forcing function and audit-trail entry (spec-001.md, Areas of concern).
      </p>
      <p className="kyc-disclaimer">
        Registration ID and legal address are likewise not verified against any real registry. They're never posted
        on-chain — every transfer's Travel Rule memo carries a reference ID to this client's record instead, resolved
        only through this application's own compliance views (spec-001.md, Move/transfer flow and Areas of concern).
      </p>

      {error && <p className="status-message status-error">{error}</p>}
      {lastResult && (
        <p className="status-message status-success">
          Onboarded "{lastResult.name}" — status: {lastResult.status}, risk: {lastResult.riskLabel}, KYC ref:{" "}
          {lastResult.kycReference}, ATA: <span className="mono-cell">{lastResult.ataAddress}</span>{" "}
          <CopyButton value={lastResult.ataAddress} />
        </p>
      )}

      <h3>Onboarded clients</h3>
      {loadingClients ? (
        <p>Loading…</p>
      ) : clients.length === 0 ? (
        <p>No clients onboarded yet.</p>
      ) : (
        <div className="table-scroll">
        <table className="clients-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Risk</th>
              <th>Status</th>
              <th>KYC reference</th>
              <th>Registration ID</th>
              <th>Legal address</th>
              <th>ATA</th>
              <th>Cash balance</th>
              <th>Tokenized</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <span className={RISK_BADGE[c.riskLabel]}>{c.riskLabel}</span>
                </td>
                <td>{c.status}</td>
                <td>{c.kycReference}</td>
                <td title={c.registrationId}>
                  {c.registrationId.length > 24 ? `${c.registrationId.slice(0, 24)}…` : c.registrationId}
                </td>
                <td title={c.legalAddress}>
                  {c.legalAddress.length > 24 ? `${c.legalAddress.slice(0, 24)}…` : c.legalAddress}
                </td>
                <td>
                  <span className="ata-cell">
                    <span className="mono-cell" title={c.ataAddress}>
                      {c.ataAddress.slice(0, 8)}…
                    </span>
                    <CopyButton value={c.ataAddress} />
                  </span>
                </td>
                <td>{formatCents(c.cashBalanceCents)}</td>
                <td>{formatCents(c.tokenizedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
