import { EmailError, getEmailSender } from "../../../../lib/email.js";
import { apiError, clientIp, json, readJson } from "../../../../lib/http.js";
import { rateLimitPerMinute } from "../../../../lib/rateLimit.js";
import { normalizeEmail, startRecovery } from "../../../../lib/signup.js";
import { getStore } from "../../../../lib/store.js";

const PER_IP = 5;
const PER_EMAIL = 2;

/**
 * POST /v1/keys/recover  { "email": "voce@exemplo.com.br" }
 *
 * Caminho para quem perdeu a chave: envia um código que, confirmado, substitui a chave do
 * e-mail. Rota pública — é justamente a chave que está indisponível.
 *
 * Responde 202 em todo e-mail válido, exista chave ou não, pela mesma razão do cadastro: a
 * resposta não pode servir de oráculo para descobrir quem está cadastrado.
 */
export async function POST(req: Request) {
  const store = getStore();
  const sender = getEmailSender();
  if (!sender) return apiError(503, "recovery_unavailable", "A recuperação não está disponível no momento.");

  const ip = clientIp(req);
  const byIp = await rateLimitPerMinute(store, `rlr:ip:${ip ?? "unknown"}`, PER_IP);
  if (!byIp.allowed) {
    return apiError(429, "rate_limited", "Muitos pedidos. Tente novamente em instantes.", {
      "retry-after": String(byIp.retryAfter),
    });
  }

  const body = await readJson<{ email?: unknown }>(req);
  const email = normalizeEmail(body?.email);
  if (!email) return apiError(400, "invalid_email", 'Envie { "email": "voce@exemplo.com.br" }.');

  const byEmail = await rateLimitPerMinute(store, `rlr:email:${email}`, PER_EMAIL);
  if (!byEmail.allowed) {
    return apiError(429, "rate_limited", "Já enviamos um código recente para este e-mail. Verifique a caixa de entrada.", {
      "retry-after": String(byEmail.retryAfter),
    });
  }

  try {
    await startRecovery({ store, email: sender }, email);
  } catch (err) {
    if (err instanceof EmailError) {
      console.error("recovery_email_failed", err.status, err.detail);
      return apiError(502, "email_send_failed", "Não foi possível enviar o e-mail agora. Tente novamente.");
    }
    throw err;
  }

  return json({ status: "accepted", message: "Se houver chave para este e-mail, enviamos as instruções." }, 202);
}
