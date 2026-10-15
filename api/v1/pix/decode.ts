import { apiError, json, readJson } from "../../../lib/http.js";
import { parseBrCode } from "../../../lib/pix.js";
import { withApi } from "../../../lib/withApi.js";

/** Um BR Code real fica bem abaixo disso; o teto serve para recusar lixo de entrada. */
const MAX_PAYLOAD = 1024;

/**
 * POST /v1/pix/decode  { "br_code": "00020101..." }
 *
 * Abre um "Pix copia e cola": confere o CRC e devolve os campos (chave, beneficiário, valor,
 * txid). Útil para conferir um código recebido antes de pagar ou de repassar ao cliente.
 *
 * Payload bem formado mas com CRC errado volta 200 com `valid: false` e o que deu para ler —
 * quem está depurando um código quebrado precisa ver os campos, não só o erro. Só 400 quando
 * o conteúdo não é TLV válido.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<{ br_code?: unknown }>(req);
  const payload = typeof body?.br_code === "string" ? body.br_code : null;
  if (!payload || payload.length === 0 || payload.length > MAX_PAYLOAD) {
    return apiError(400, "invalid_body", `Envie { "br_code": "..." } com até ${MAX_PAYLOAD} caracteres.`);
  }

  const decoded = parseBrCode(payload);
  if (!decoded) return apiError(400, "malformed_br_code", "O conteúdo não é um BR Code válido.");

  return json(decoded);
});
