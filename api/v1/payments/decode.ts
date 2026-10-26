import { apiError, json, readJson } from "../../../lib/http.js";
import { decodePayment } from "../../../lib/payments.js";
import { withApi } from "../../../lib/withApi.js";

const MAX_INPUT = 1024;

/**
 * POST /v1/payments/decode  { "code": "..." }
 *
 * Aceita Pix copia e cola, linha digitável ou código de barras, identifica o formato sozinho e
 * devolve um envelope comum (valor, vencimento, beneficiário) mais a decodificação completa em
 * `details`. Serve para quando o usuário cola algo e você ainda não sabe o que é.
 *
 * Formato reconhecido com verificação falhando responde 200 com `valid: false` e os campos que
 * deram para ler. 400 só quando o conteúdo não é nenhum dos formatos.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<{ code?: unknown }>(req);
  const code = typeof body?.code === "string" ? body.code : null;
  if (!code || code.length === 0 || code.length > MAX_INPUT) {
    return apiError(400, "invalid_body", `Envie { "code": "..." } com até ${MAX_INPUT} caracteres.`);
  }

  const decoded = decodePayment(code);
  if (!decoded) {
    return apiError(
      400,
      "unrecognized_code",
      "O conteúdo não é um Pix copia e cola, linha digitável nem código de barras.",
    );
  }

  return json(decoded);
});
