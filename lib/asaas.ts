/**
 * Cliente mínimo da API do Asaas (v3), sem dependências.
 * Referência: https://docs.asaas.com — autenticação pelo header `access_token`;
 * a chave e a URL precisam ser do mesmo ambiente (sandbox ou produção).
 */

const SANDBOX_URL = "https://api-sandbox.asaas.com/v3";
const PRODUCTION_URL = "https://api.asaas.com/v3";

export interface AsaasConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AsaasPayment {
  id: string;
  status?: string;
  invoiceUrl?: string;
  dueDate?: string;
}

export class AsaasError extends Error {
  constructor(
    public readonly status: number,
    public readonly details: { code?: string; description?: string }[],
  ) {
    super(`asaas_http_${status}`);
    this.name = "AsaasError";
  }
}

/** Sem ASAAS_API_KEY a cobrança fica desligada. Sandbox é o padrão: produção exige ASAAS_ENV=production. */
export function asaasConfigFromEnv(): AsaasConfig | null {
  const apiKey = process.env.ASAAS_API_KEY;
  if (!apiKey) return null;
  return { apiKey, baseUrl: process.env.ASAAS_ENV === "production" ? PRODUCTION_URL : SANDBOX_URL };
}

export function createAsaasClient(config: AsaasConfig) {
  const doFetch = config.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        access_token: config.apiKey,
        "user-agent": "apis-portfolio/0.1.0 (billing)",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const raw = (data as { errors?: unknown } | null)?.errors;
      const details = Array.isArray(raw)
        ? raw.map((e) => ({
            code: typeof e?.code === "string" ? e.code : undefined,
            description: typeof e?.description === "string" ? e.description : undefined,
          }))
        : [];
      throw new AsaasError(res.status, details);
    }
    return data as T;
  }

  return {
    createCustomer(input: { name: string; cpfCnpj: string; email: string; externalReference: string }) {
      return request<{ id: string }>("POST", "/customers", input);
    },

    createSubscription(input: {
      customer: string;
      billingType: "UNDEFINED" | "BOLETO" | "CREDIT_CARD" | "PIX";
      value: number;
      nextDueDate: string;
      cycle: "MONTHLY";
      description: string;
      externalReference: string;
      callback?: { successUrl: string; autoRedirect?: boolean };
    }) {
      return request<{ id: string; status?: string; paymentLink?: string | null }>("POST", "/subscriptions", input);
    },

    deleteSubscription(id: string) {
      return request<unknown>("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
    },

    listSubscriptionPayments(id: string, status?: string) {
      const query = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<{ data?: AsaasPayment[] }>("GET", `/subscriptions/${encodeURIComponent(id)}/payments${query}`);
    },
  };
}

export type AsaasClient = ReturnType<typeof createAsaasClient>;

export function getAsaasClient(): AsaasClient | null {
  const config = asaasConfigFromEnv();
  return config ? createAsaasClient(config) : null;
}
