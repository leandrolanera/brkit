import { getEmailSender } from "../../../../lib/email.js";
import { apiError, clientIp, json, readJson } from "../../../../lib/http.js";
import { PLANS } from "../../../../lib/plans.js";
import { rateLimitPerMinute } from "../../../../lib/rateLimit.js";
import { normalizeEmail, SignupError, verifyRecovery } from "../../../../lib/signup.js";
import { getStore } from "../../../../lib/store.js";

const PER_IP = 10;

/**
 * POST /v1/keys/recover/verify  { "email": "...", "code": "ABCD2345" }
 *
 * Confere o código e devolve a chave nova. A anterior deixa de funcionar na hora; o id é
 * preservado, então plano, cota do mês, QR Codes e assinatura continuam valendo.
 */
export async function POST(req: Request) {
  const store = getStore();
  // Se o envio está desligado, ninguém pôde receber código: responder "código inválido" seria
  // enganoso.
  if (!getEmailSender()) return apiError(503, "recovery_unavailable", "A recuperação não está disponível no momento.");

  const ip = clientIp(req);
  const byIp = await rateLimitPerMinute(store, `rlrv:ip:${ip ?? "unknown"}`, PER_IP);
  if (!byIp.allowed) {
    return apiError(429, "rate_limited", "Muitas tentativas. Tente novamente em instantes.", {
      "retry-after": String(byIp.retryAfter),
    });
  }

  const body = await readJson<{ email?: unknown; code?: unknown }>(req);
  const email = normalizeEmail(body?.email);
  const code = typeof body?.code === "string" ? body.code.trim() : null;
  if (!email || !code || code.length > 32) {
    return apiError(400, "invalid_body", 'Envie { "email": "...", "code": "..." }.');
  }

  try {
    const { api_key, record } = await verifyRecovery({ store }, email, code);
    return json({
      api_key,
      key_id: record.id,
      owner: record.owner,
      plan: record.plan,
      rotated_at: record.rotatedAt ?? null,
      limits: {
        monthly_quota: PLANS[record.plan].monthlyQuota,
        per_minute: PLANS[record.plan].perMinute,
      },
      warning: "Guarde a chave agora: ela não será exibida de novo. A anterior já não funciona.",
    });
  } catch (err) {
    if (err instanceof SignupError) return apiError(err.status, err.code, err.message);
    throw err;
  }
}
