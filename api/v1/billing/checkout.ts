import { getAsaasClient } from "../../../lib/asaas.js";
import { billingErrorResponse, startCheckout } from "../../../lib/billing.js";
import { apiError, json, readJson } from "../../../lib/http.js";
import { isPaidPlan } from "../../../lib/plans.js";
import { isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf } from "../../../lib/validators.js";
import { withApi } from "../../../lib/withApi.js";

interface CheckoutBody {
  plan?: unknown;
  customer?: { name?: unknown; document?: unknown; email?: unknown } | null;
}

/**
 * POST /v1/billing/checkout
 * { "plan": "pro", "customer": { "name": "...", "document": "CPF ou CNPJ", "email": "..." } }
 * Cria a assinatura mensal no Asaas e devolve o link da fatura (Pix, boleto ou cartão).
 * Não consome a cota, para funcionar também quando ela já acabou.
 * O documento do cliente vai direto ao Asaas e não é guardado aqui.
 */
export const POST = withApi(
  async (req, { key, store }) => {
    const asaas = getAsaasClient();
    if (!asaas) return apiError(503, "billing_unavailable", "A cobrança não está disponível no momento.");

    const body = await readJson<CheckoutBody>(req);
    if (!isPaidPlan(body?.plan)) return apiError(400, "invalid_plan", "plan deve ser pro ou scale.");

    const name = typeof body?.customer?.name === "string" ? body.customer.name.trim() : "";
    if (name.length < 3 || name.length > 100) {
      return apiError(400, "invalid_name", "customer.name deve ter entre 3 e 100 caracteres.");
    }

    const email = typeof body?.customer?.email === "string" ? body.customer.email.trim() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return apiError(400, "invalid_email", "customer.email inválido.");
    }

    const rawDocument = typeof body?.customer?.document === "string" ? body.customer.document : "";
    const document = isValidCpf(rawDocument)
      ? normalizeCpf(rawDocument)
      : isValidCnpj(rawDocument)
        ? normalizeCnpj(rawDocument)
        : null;
    if (!document) return apiError(400, "invalid_document", "customer.document deve ser um CPF ou CNPJ válido.");

    try {
      const result = await startCheckout(
        { store, asaas, successUrl: process.env.BILLING_SUCCESS_URL || undefined },
        key,
        { plan: body.plan, customer: { name, document, email } },
      );
      return json(result, 201);
    } catch (err) {
      return billingErrorResponse(err);
    }
  },
  { cost: 0 },
);
