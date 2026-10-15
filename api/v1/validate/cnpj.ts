import { apiError, json, readJson } from "../../../lib/http.js";
import { cnpjKind, formatCnpj, isValidCnpj, normalizeCnpj } from "../../../lib/validators.js";
import { withApi } from "../../../lib/withApi.js";

function answer(value: string | null | undefined): Response {
  if (!value || value.length > 32) {
    return apiError(400, "missing_value", "Informe o CNPJ em value (query string ou corpo JSON).");
  }
  const valid = isValidCnpj(value);
  return json({
    valid,
    kind: valid ? cnpjKind(value) : null,
    normalized: valid ? normalizeCnpj(value) : null,
    formatted: valid ? formatCnpj(value) : null,
  });
}

/**
 * GET  /v1/validate/cnpj?value=12.ABC.345/01DE-35
 * POST /v1/validate/cnpj  { "value": "..." }
 * Aceita CNPJ numérico e alfanumérico (formato em uso desde julho de 2026).
 * Valida formato e dígitos verificadores; não consulta a Receita.
 */
export const GET = withApi((req) => answer(new URL(req.url).searchParams.get("value")));

export const POST = withApi(async (req) => {
  const body = await readJson<{ value?: unknown }>(req);
  return answer(typeof body?.value === "string" ? body.value : null);
});
