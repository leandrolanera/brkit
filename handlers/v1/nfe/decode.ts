import { apiError, json, readJson } from "../../../lib/http.js";
import { KEY_LENGTH, parseAccessKey } from "../../../lib/nfe.js";
import { withApi } from "../../../lib/withApi.js";

/**
 * POST /v1/nfe/decode  { "key": "35260611222333000181550010000000011000000010" }
 *
 * Lê a chave de acesso de NF-e, NFC-e, CT-e ou MDF-e: confere o dígito verificador e abre os
 * campos — UF, emissão, CNPJ do emitente, modelo, série, número e forma de emissão.
 *
 * Formato certo com dígito errado responde 200 com `valid: false` e o motivo. 400 só quando o
 * conteúdo não tem a forma de uma chave.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<{ key?: unknown }>(req);
  const key = typeof body?.key === "string" ? body.key : null;
  if (!key || key.length === 0 || key.length > 64) {
    return apiError(400, "invalid_body", `Envie { "key": "..." } com os ${KEY_LENGTH} caracteres da chave.`);
  }

  const decoded = parseAccessKey(key);
  if (!decoded) {
    return apiError(
      400,
      "invalid_key_format",
      `A chave precisa ter ${KEY_LENGTH} caracteres: 6 dígitos, 12 alfanuméricos (CNPJ) e 26 dígitos.`,
    );
  }

  return json(decoded);
});
