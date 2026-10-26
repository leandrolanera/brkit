import { apiError, json, readJson } from "../../../lib/http.js";
import { formatCpf, isValidCpf, normalizeCpf } from "../../../lib/validators.js";
import { withApi } from "../../../lib/withApi.js";

/**
 * POST /v1/validate/cpf  { "value": "529.982.247-25" }
 * CPF é dado pessoal: só aceitamos no corpo (query string vai para logs) e nada é armazenado.
 * Valida apenas o formato e os dígitos verificadores; não consulta a Receita.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<{ value?: unknown }>(req);
  if (typeof body?.value !== "string" || body.value.length === 0 || body.value.length > 32) {
    return apiError(400, "invalid_body", "Envie { \"value\": \"...\" } com o CPF.");
  }
  const valid = isValidCpf(body.value);
  return json({
    valid,
    normalized: valid ? normalizeCpf(body.value) : null,
    formatted: valid ? formatCpf(body.value) : null,
  });
});
