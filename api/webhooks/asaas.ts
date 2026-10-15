import { createHash, timingSafeEqual } from "node:crypto";
import { handleAsaasEvent, type AsaasEvent } from "../../lib/billing.js";
import { apiError, json, readJson } from "../../lib/http.js";
import { getStore } from "../../lib/store.js";

function tokenMatches(received: string | null, expected: string): boolean {
  if (!received) return false;
  // Compara os hashes para ter sempre o mesmo tamanho e tempo constante.
  const a = createHash("sha256").update(received).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * POST /api/webhooks/asaas — cadastre essa URL como webhook no Asaas, com o mesmo token de
 * ASAAS_WEBHOOK_TOKEN. O Asaas envia o token no header asaas-access-token.
 * Responde 200 também para eventos ignorados ou repetidos: falhas seguidas pausam a fila do webhook.
 */
export async function POST(req: Request) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) return apiError(503, "webhook_not_configured", "ASAAS_WEBHOOK_TOKEN não está definido.");
  if (!tokenMatches(req.headers.get("asaas-access-token"), expected)) {
    return apiError(401, "invalid_token", "Token inválido.");
  }

  const event = await readJson<AsaasEvent>(req);
  if (!event || typeof event !== "object") return apiError(400, "invalid_body", "Corpo JSON inválido.");

  try {
    const outcome = await handleAsaasEvent(getStore(), event);
    return json({ received: true, outcome });
  } catch (err) {
    console.error("webhook_error", err);
    return apiError(500, "internal_error", "Erro interno.");
  }
}
