import { getAsaasClient } from "../../../lib/asaas.js";
import { billingErrorResponse, cancelSubscription, getBillingStatus } from "../../../lib/billing.js";
import { apiError, json } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

/** GET /v1/billing — plano em vigor, vencimento, assinatura, uso do mês e link de pagamento pendente. */
export const GET = withApi(
  async (_req, { key, store }) => json(await getBillingStatus({ store, asaas: getAsaasClient() }, key)),
  { cost: 0 },
);

/** DELETE /v1/billing — cancela a assinatura. O acesso pago continua até o fim do período já pago. */
export const DELETE = withApi(
  async (_req, { key, store }) => {
    const asaas = getAsaasClient();
    if (!asaas) return apiError(503, "billing_unavailable", "A cobrança não está disponível no momento.");
    try {
      return json(await cancelSubscription({ store, asaas }, key));
    } catch (err) {
      return billingErrorResponse(err);
    }
  },
  { cost: 0 },
);
