const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4100";

export interface Client {
  id: string;
  name: string;
  riskRating: 0 | 1 | 2;
  riskLabel: "low" | "medium" | "high";
  ataAddress: string;
  ownerAddress: string;
  status: string;
  kycReference: string;
  registrationId: string;
  legalAddress: string;
  cashBalanceCents: number;
  tokenizedCents: number;
  createdAt: string;
}

export interface OnboardResponse extends Client {
  velocityAccount: string;
  signature: string;
  // Present only when onboarding confirmed on-chain but hadn't reached
  // Solana's "finalized" commitment before this response was sent — see
  // spec-001.md's Technical approach ("settled" vs "finalized"). The
  // client is still created (status: "confirmed", not yet "active").
  warning?: string;
}

export interface DepositResponse {
  depositEventId: string;
  signature: string;
  cashBalanceCents: number;
  tokenizedCents: number;
  onChainBalanceCents: number;
}

export interface TransferResponse {
  signature: string;
  senderCashBalanceCents: number;
  senderTokenizedCents: number;
  senderOnChainBalanceCents: number;
  recipientCashBalanceCents: number;
  recipientTokenizedCents: number;
  recipientOnChainBalanceCents: number;
}

export class TransferApiError extends Error {
  constructor(message: string, public sanctionsBadge?: string) {
    super(message);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function listClients(): Promise<Client[]> {
  const res = await fetch(`${API_BASE_URL}/clients`);
  return handleResponse(res);
}

export async function onboardClient(
  name: string,
  riskRating: number,
  kycReference: string,
  registrationId: string,
  legalAddress: string,
): Promise<OnboardResponse> {
  const res = await fetch(`${API_BASE_URL}/clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, riskRating, kycReference, registrationId, legalAddress }),
  });
  return handleResponse(res);
}

export async function simulateDeposit(clientId: string, amountCents: number): Promise<DepositResponse> {
  const res = await fetch(`${API_BASE_URL}/deposits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, amountCents }),
  });
  return handleResponse(res);
}

export async function transferTokens(
  senderId: string,
  recipientId: string,
  amountCents: number,
  reference: string,
  remittance: string,
): Promise<TransferResponse> {
  const res = await fetch(`${API_BASE_URL}/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ senderId, recipientId, amountCents, reference, remittance }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new TransferApiError(body.error ?? `Request failed: ${res.status}`, body.sanctionsBadge);
  }
  return res.json();
}
