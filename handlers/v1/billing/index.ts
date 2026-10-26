import { getAsaasClient } from "../../../lib/asaas.js";
import { billingErrorResponse, cancelSubscription, changePlan, getBillingStatus } from "../../../lib/billing.js";
import { apiError, json, readJson } from "../../../lib/http.js";
import { isPaidPlan } from "../../../lib/plans.js";
import { withApi } from "../../../lib/withApi.js";

/** GET /v1/billing — plano em vigor, vencimento, assinatura, uso do mês e link de pagamento pendente. */
export const GET = withApi(
  async (_req, { key, store }) => json(await getBillingStatus({ store, asaas: getAsaasClient() }, key)),
  { cost: 0 },
);

/**
 * PUT /v1/billing  { "plan": "scale" }
 *
 * Troca o plano da assinatura ativa, sem cancelar e contratar de novo.
 * Upgrade vale na hora; downgrade vale no próximo pagamento confirmado (ver lib/billing.ts).
 * Pedir o plano em que a chave já está responde 200 com `changed: false`.
 */
export const PUT = withApi(
  async (req, { key, store }) => {
    const asaas = getAsaasClient();
    if (!asaas) return apiError(503, "billing_unavailable", "A cobrança não está disponível no momento.");

    const body = await readJson<{ plan?: unknown }>(req);
    if (!isPaidPlan(body?.plan)) {
      return apiError(400, "invalid_plan", "plan deve ser pro ou scale. Para sair de um plano pago, use DELETE.");
    }

    try {
      return json(await changePlan({ store, asaas }, key, body.plan));
    } catch (err) {
      return billingErrorResponse(err);
    }
  },
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
