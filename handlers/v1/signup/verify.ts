import { getEmailSender } from "../../../lib/email.js";
import { apiError, clientIp, json, readJson } from "../../../lib/http.js";
import { PLANS } from "../../../lib/plans.js";
import { rateLimitPerMinute } from "../../../lib/rateLimit.js";
import { normalizeEmail, SignupError, verifySignup } from "../../../lib/signup.js";
import { getStore } from "../../../lib/store.js";

/** Tentativas por minuto por IP, somando todos os e-mails. O limite por código fica em lib/signup.ts. */
const PER_IP = 10;

/**
 * POST /v1/signup/verify  { "email": "voce@exemplo.com.br", "code": "ABCD2345" }
 *
 * Confere o código e devolve a chave de API. **A chave aparece só nesta resposta**: o que fica
 * guardado é o hash dela.
 */
export async function POST(req: Request) {
  const store = getStore();
  // O envio não é usado aqui, mas se o cadastro está desligado a verificação também está:
  // responder 400 "código inválido" para quem nunca pôde receber um código seria enganoso.
  if (!getEmailSender()) return apiError(503, "signup_unavailable", "O cadastro não está disponível no momento.");

  const ip = clientIp(req);
  const byIp = await rateLimitPerMinute(store, `rlsv:ip:${ip ?? "unknown"}`, PER_IP);
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
    const { api_key, record } = await verifySignup({ store }, email, code);
    return json(
      {
        api_key,
        key_id: record.id,
        owner: record.owner,
        plan: record.plan,
        limits: {
          monthly_quota: PLANS[record.plan].monthlyQuota,
          per_minute: PLANS[record.plan].perMinute,
        },
        warning: "Guarde a chave agora: ela não será exibida de novo.",
      },
      201,
    );
  } catch (err) {
    if (err instanceof SignupError) return apiError(err.status, err.code, err.message);
    throw err;
  }
}
