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
  cashBalanceCents: number;
  tokenizedCents: number;
  createdAt: string;
}

export interface OnboardResponse extends Client {
  velocityAccount: string;
  signature: string;
}

export interface DepositResponse {
  depositEventId: string;
  signature: string;
  cashBalanceCents: number;
  tokenizedCents: number;
  onChainBalanceCents: number;
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
): Promise<OnboardResponse> {
  const res = await fetch(`${API_BASE_URL}/clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, riskRating, kycReference }),
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
