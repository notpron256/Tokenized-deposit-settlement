import { useEffect, useState } from "react";
import { listClients, simulateDeposit, type Client } from "../lib/api";

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export default function Fund() {
  const [clients, setClients] = useState<Client[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setLastResult(null);
    const client = clients.find((c) => c.id === clientId);
    try {
      const result = await simulateDeposit(clientId, amountCents);
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fund-page">
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
          Deposit amount (USD)
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="10000.00"
            disabled={submitting}
            required
          />
        </label>
        <button type="submit" disabled={!canSubmit}>
          {submitting ? "Simulating…" : "Simulate Deposit"}
        </button>
      </form>

      <p className="kyc-disclaimer">
        This simulates the deposit event feed described in spec-001.md (no manual ledger/mint entry) — clicking
        "Simulate Deposit" is the synthetic event, not a direct edit of the ledger or a direct mint call.
      </p>

      {error && <p className="status-message status-error">{error}</p>}
      {lastResult && (
        <p className="status-message status-success">
          Deposited {formatCents(lastResult.amountCents)} for "{lastResult.clientName}" — ledger cash balance:{" "}
          {formatCents(lastResult.cashBalanceCents)}, ledger tokenized:{" "}
          {formatCents(lastResult.tokenizedCents)}, on-chain ATA balance (read back directly):{" "}
          {formatCents(lastResult.onChainBalanceCents)}
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
              <th>Status</th>
              <th>Cash balance</th>
              <th>Tokenized</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
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
