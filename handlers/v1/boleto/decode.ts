import { decodeBoleto } from "../../../lib/boleto.js";
import { apiError, json, readJson } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

/** Uma linha digitável tem 48 dígitos no máximo; o teto é folgado para aceitar pontuação. */
const MAX_INPUT = 128;

/**
 * POST /v1/boleto/decode  { "code": "00190.50095 40144.816069 ..." }
 *
 * Aceita linha digitável (47 ou 48 dígitos) ou código de barras (44), com ou sem pontuação, e
 * identifica o formato sozinho: cobrança bancária ou arrecadação (água, luz, tributos).
 * Devolve as duas representações, então também serve de conversor entre elas.
 *
 * Só POST: a linha digitável identifica um pagamento e query string vai para log.
 *
 * Comprimento válido com DV errado volta 200 com `valid: false` e `errors` — é o caso de quem
 * digitou um dígito errado e precisa saber onde. 400 só quando o comprimento não corresponde a
 * nenhum dos formatos.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<{ code?: unknown }>(req);
  const code = typeof body?.code === "string" ? body.code : null;
  if (!code || code.length === 0 || code.length > MAX_INPUT) {
    return apiError(400, "invalid_body", `Envie { "code": "..." } com a linha digitável ou o código de barras.`);
  }

  const decoded = decodeBoleto(code);
  if (!decoded) {
    return apiError(
      400,
      "invalid_length",
      "O código precisa ter 44 dígitos (código de barras), 47 (linha digitável de cobrança) ou 48 (arrecadação).",
    );
  }

  return json(decoded);
});
