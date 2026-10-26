import { rotateApiKey } from "../../../lib/auth.js";
import { apiError, json } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

/**
 * POST /v1/keys/rotate — autenticado com a chave atual.
 *
 * Emite um segredo novo e revoga o atual **na hora**. O id é preservado, então plano, cota do
 * mês, QR Codes e assinatura continuam valendo (ver rotateApiKey).
 *
 * Não consome cota: rotacionar por suspeita de vazamento precisa funcionar mesmo com a cota
 * esgotada.
 *
 * Atenção: se a resposta se perder no caminho, a chave antiga já estará revogada e a nova
 * desconhecida. O jeito de sair disso é a recuperação por e-mail em POST /v1/keys/recover.
 */
export const POST = withApi(
  async (_req, { key, store }) => {
    const rotated = await rotateApiKey(store, key.id);
    // A chave acabou de autenticar esta chamada, então só não existiria numa corrida com
    // outra rotação simultânea.
    if (!rotated) return apiError(409, "rotation_conflict", "A chave mudou durante a rotação. Tente novamente.");

    return json({
      api_key: rotated.key,
      key_id: rotated.record.id,
      owner: rotated.record.owner,
      plan: rotated.record.plan,
      rotated_at: rotated.record.rotatedAt ?? null,
      warning: "Guarde a chave agora: ela não será exibida de novo. A anterior já não funciona.",
    });
  },
  { cost: 0 },
);
