import { useEffect, useState } from "react";
import { listClients, transferTokens, TransferApiError, type Client } from "../lib/api";

const RISK_BADGE: Record<string, string> = {
  low: "risk-badge risk-low",
  medium: "risk-badge risk-medium",
  high: "risk-badge risk-high",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function Transfer() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [senderId, setSenderId] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [remittance, setRemittance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sanctionsBadge, setSanctionsBadge] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    senderName: string;
    recipientName: string;
    amountCents: number;
    senderTokenizedCents: number;
    senderOnChainBalanceCents: number;
    recipientTokenizedCents: number;
    recipientOnChainBalanceCents: number;
    signature: string;
  } | null>(null);

  async function refreshClients() {
    setLoadingClients(true);
    try {
      const data = await listClients();
      setClients(data);
      setSenderId((current) => current || data[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingClients(false);
    }
  }

  useEffect(() => {
    refreshClients();
  }, []);

  const recipientOptions = clients.filter((c) => c.id !== senderId);
  useEffect(() => {
    if (recipientId === senderId) setRecipientId("");
  }, [senderId, recipientId]);

  const amountCents = Math.round(Number(amount) * 100);
  const canSubmit =
    !submitting && !!senderId && !!recipientId && senderId !== recipientId && Number.isFinite(amountCents) && amountCents > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setSanctionsBadge(null);
    setLastResult(null);
    const sender = clients.find((c) => c.id === senderId);
    const recipient = clients.find((c) => c.id === recipientId);
    try {
      const result = await transferTokens(senderId, recipientId, amountCents, reference, remittance);
      setLastResult({
        senderName: sender?.name ?? senderId,
        recipientName: recipient?.name ?? recipientId,
        amountCents,
        senderTokenizedCents: result.senderTokenizedCents,
        senderOnChainBalanceCents: result.senderOnChainBalanceCents,
        recipientTokenizedCents: result.recipientTokenizedCents,
        recipientOnChainBalanceCents: result.recipientOnChainBalanceCents,
        signature: result.signature,
      });
      setAmount("");
      setReference("");
      setRemittance("");
      await refreshClients();
    } catch (err) {
      if (err instanceof TransferApiError) {
        setError(err.message);
        if (err.sanctionsBadge) setSanctionsBadge(err.sanctionsBadge);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="transfer-page">
      <form onSubmit={handleSubmit} className="onboarding-form">
        <label>
          Sender
          <select value={senderId} onChange={(e) => setSenderId(e.target.value)} disabled={submitting}>
            {clients.length === 0 && <option value="">No onboarded clients</option>}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Recipient
          <select value={recipientId} onChange={(e) => setRecipientId(e.target.value)} disabled={submitting}>
            <option value="">Select recipient…</option>
            {recipientOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (USD)
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000.00"
            disabled={submitting}
            required
          />
        </label>
        <label>
          Transaction reference (:20:)
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="INV4521"
            disabled={submitting}
          />
          <span className="field-hint">Leave blank to demonstrate the missing-memo rejection.</span>
        </label>
        <label>
          Remittance information (:70:)
          <input
            type="text"
            value={remittance}
            onChange={(e) => setRemittance(e.target.value)}
            placeholder="Invoice #4521"
            disabled={submitting}
          />
          <span className="field-hint field-hint-spacer" aria-hidden="true">&nbsp;</span>
        </label>
        <div className="submit-field">
          <span className="field-label-spacer" aria-hidden="true">&nbsp;</span>
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Transferring…" : "Transfer"}
          </button>
          <span className="field-hint field-hint-spacer" aria-hidden="true">&nbsp;</span>
        </div>
      </form>

      <p className="kyc-disclaimer">
        Every transfer runs through the Transfer Hook's four on-chain checks (spec-001.md Move/transfer flow):
        velocity limit, Travel Rule memo, sanctions re-screen, and a non-blocking large-transaction flag for amounts
        of $10,000 or more. The memo's originator "50K" and beneficiary "59" fields are filled in automatically from
        the selected sender/recipient — each carrying a reference ID plus a SHA-256 hash of that client's identity
        data (computed fresh at transfer time), not their real name/registration ID/address in cleartext. The
        reference proves linkage to a real onboarding record; the hash proves that record's content is unaltered
        since — real data stays in Postgres, resolvable only through this application's own compliance views, never
        posted on-chain (spec-001.md, Move/transfer flow and Areas of concern).
      </p>

      {error && (
        <p className="status-message status-error">
          {error}
          {sanctionsBadge && (
            <>
              <br />
              <strong>{sanctionsBadge}</strong> — this is seeded test data for demoing the check, never a real OFAC
              hit.
            </>
          )}
        </p>
      )}
      {lastResult && (
        <p className="status-message status-success">
          Transferred {formatCents(lastResult.amountCents)} from "{lastResult.senderName}" to "
          {lastResult.recipientName}" — sender tokenized: {formatCents(lastResult.senderTokenizedCents)} (on-chain:{" "}
          {formatCents(lastResult.senderOnChainBalanceCents)}), recipient tokenized:{" "}
          {formatCents(lastResult.recipientTokenizedCents)} (on-chain:{" "}
          {formatCents(lastResult.recipientOnChainBalanceCents)})
          {lastResult.senderTokenizedCents === lastResult.senderOnChainBalanceCents &&
          lastResult.recipientTokenizedCents === lastResult.recipientOnChainBalanceCents
            ? " — matches."
            : " — MISMATCH."}
        </p>
      )}

      <h3>Onboarded clients</h3>
      {loadingClients ? (
        <p>Loading…</p>
      ) : clients.length === 0 ? (
        <p>No clients onboarded yet — onboard a client first.</p>
      ) : (
        <table className="clients-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Risk</th>
              <th>Status</th>
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
                <td>{formatCents(c.cashBalanceCents)}</td>
                <td>{formatCents(c.tokenizedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
