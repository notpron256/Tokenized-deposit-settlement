import { useEffect, useState } from "react";
import { listClients, redeemTokens, RedeemApiError, type Client } from "../lib/api";

const RISK_BADGE: Record<string, string> = {
  low: "risk-badge risk-low",
  medium: "risk-badge risk-medium",
  high: "risk-badge risk-high",
};

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function Redeem() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sanctionsBadge, setSanctionsBadge] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{
    clientName: string;
    amountCents: number;
    cashBalanceCents: number;
    tokenizedCents: number;
    onChainBalanceCents: number;
    signature: string;
  } | null>(null);

  async function refreshClients() {
    setLoadingClients(true);
    try {
      const data = await listClients();
      setClients(data);
      setClientId((current) => current || data[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingClients(false);
    }
  }

  useEffect(() => {
    refreshClients();
  }, []);

  const amountCents = Math.round(Number(amount) * 100);
  const canSubmit = !submitting && !!clientId && Number.isFinite(amountCents) && amountCents > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setSanctionsBadge(null);
    setLastResult(null);
    const client = clients.find((c) => c.id === clientId);
    try {
      const result = await redeemTokens(clientId, amountCents);
      setLastResult({
        clientName: client?.name ?? clientId,
        amountCents,
        cashBalanceCents: result.cashBalanceCents,
        tokenizedCents: result.tokenizedCents,
        onChainBalanceCents: result.onChainBalanceCents,
        signature: result.signature,
      });
      setAmount("");
      await refreshClients();
    } catch (err) {
      if (err instanceof RedeemApiError) {
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
    <div className="redeem-page">
      <form onSubmit={handleSubmit} className="onboarding-form">
        <label>
          Client
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={submitting}>
            {clients.length === 0 && <option value="">No onboarded clients</option>}
            {clients.map((c) => (
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
        <div className="submit-field">
          <span className="field-label-spacer" aria-hidden="true">
            &nbsp;
          </span>
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Redeeming…" : "Redeem"}
          </button>
        </div>
      </form>

      <details className="transfer-notes">
        <summary>How this redemption is checked and protected</summary>
        <div className="transfer-notes-body">
          <h4>Sanctions re-check</h4>
          <p>
            Redemption is the highest-value moment to catch a newly-sanctioned client, since it converts token value
            back into liquid cash — checked directly against the same on-chain SanctionsRegistry PDA the Transfer
            Hook reads, <em>before</em> the bank's compliance signer ever agrees to co-sign. A sanctioned client's
            redemption is refused outright; nothing is ever submitted on-chain for it.
          </p>
          <h4>Co-signed burn, not a transfer</h4>
          <p>
            Redemption never routes through the Transfer Hook's other checks (velocity, Travel Rule) — those govern
            value moving between two counterparties, and a burn extinguishes the token back to cash rather than
            transferring it to anyone. Instead, the client approves a scoped delegate owned by the redemption-gateway
            program, which requires <strong>both</strong> the client and the bank's compliance signer as real
            on-chain signers before it burns — enforced by the program's own account validation, not a discipline
            this app has to uphold on its own.
          </p>
        </div>
      </details>

      {submitting && (
        <p className="status-message status-pending">
          <span className="status-pending-dot" aria-hidden="true" />
          Waiting for finalized settlement — this typically takes ~15-20s, reflecting Solana's actual finality
          guarantees.
        </p>
      )}
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
          Redeemed {formatCents(lastResult.amountCents)} for "{lastResult.clientName}" — cash balance:{" "}
          {formatCents(lastResult.cashBalanceCents)}, tokenized: {formatCents(lastResult.tokenizedCents)} (on-chain:{" "}
          {formatCents(lastResult.onChainBalanceCents)})
          {lastResult.tokenizedCents === lastResult.onChainBalanceCents ? " — matches." : " — MISMATCH."}
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
