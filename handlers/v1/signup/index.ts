import { EmailError, getEmailSender } from "../../../lib/email.js";
import { apiError, clientIp, json, readJson } from "../../../lib/http.js";
import { rateLimitPerMinute } from "../../../lib/rateLimit.js";
import { normalizeEmail, startSignup } from "../../../lib/signup.js";
import { getStore } from "../../../lib/store.js";

/** Pedidos por minuto por IP. Folgado para um escritório atrás de NAT, apertado para robô. */
const PER_IP = 5;

/** Pedidos por minuto para o mesmo e-mail: evita usar o cadastro para inundar a caixa de alguém. */
const PER_EMAIL = 2;

/**
 * POST /v1/signup  { "email": "voce@exemplo.com.br" }
 *
 * Envia um código de verificação. Rota pública: não exige chave de API, porque é justamente
 * ela que está sendo criada.
 *
 * Responde 202 em todos os casos de entrada válida, inclusive quando o e-mail já tem chave.
 * Dizer a diferença daria um jeito de descobrir quem está cadastrado; quem já tem chave recebe
 * um e-mail explicando, em vez de um código.
 */
export async function POST(req: Request) {
  const store = getStore();
  const sender = getEmailSender();
  if (!sender) return apiError(503, "signup_unavailable", "O cadastro não está disponível no momento.");

  const ip = clientIp(req);
  const byIp = await rateLimitPerMinute(store, `rls:ip:${ip ?? "unknown"}`, PER_IP);
  if (!byIp.allowed) {
    return apiError(429, "rate_limited", "Muitos pedidos. Tente novamente em instantes.", {
      "retry-after": String(byIp.retryAfter),
    });
  }

  const body = await readJson<{ email?: unknown }>(req);
  const email = normalizeEmail(body?.email);
  if (!email) return apiError(400, "invalid_email", 'Envie { "email": "voce@exemplo.com.br" }.');

  // Depois de validar o e-mail: assim um corpo inválido não consome a cota de quem é legítimo.
  const byEmail = await rateLimitPerMinute(store, `rls:email:${email}`, PER_EMAIL);
  if (!byEmail.allowed) {
    return apiError(429, "rate_limited", "Já enviamos um código recente para este e-mail. Verifique a caixa de entrada.", {
      "retry-after": String(byEmail.retryAfter),
    });
  }

  try {
    await startSignup({ store, email: sender }, email);
  } catch (err) {
    if (err instanceof EmailError) {
      console.error("signup_email_failed", err.status, err.detail);
      return apiError(502, "email_send_failed", "Não foi possível enviar o e-mail agora. Tente novamente.");
    }
    throw err;
  }

  return json({ status: "accepted", message: "Se o e-mail for válido, enviamos as instruções para ele." }, 202);
}
