import { apiError, json, readJson } from "../../../lib/http.js";
import { buildAccessKey, NfeError, parseAccessKey } from "../../../lib/nfe.js";
import { withApi } from "../../../lib/withApi.js";

interface Body {
  uf?: unknown;
  issued?: unknown;
  cnpj?: unknown;
  model?: unknown;
  series?: unknown;
  number?: unknown;
  emissionType?: unknown;
  randomCode?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

/**
 * POST /v1/nfe/key
 * { "uf": "SP", "issued": "2026-06", "cnpj": "11.222.333/0001-81", "model": "55",
 *   "series": 1, "number": 1 }
 *
 * Monta a chave de acesso a partir dos campos e calcula o dígito verificador. É o caminho de
 * quem emite: o ERP tem os campos e precisa da chave.
 *
 * `randomCode` (cNF) é sorteado quando não vem — é o que a especificação espera dele. Informe
 * se precisar reproduzir uma chave existente.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<Body>(req);
  if (!body || typeof body !== "object") {
    return apiError(400, "invalid_body", "Envie um corpo JSON com uf, issued, cnpj, model, series e number.");
  }

  const uf = text(body.uf);
  const issued = text(body.issued);
  const cnpj = text(body.cnpj);
  const model = text(body.model);
  const series = text(body.series);
  const number = text(body.number);
  if (!uf || !issued || !cnpj || !model || series === undefined || number === undefined) {
    return apiError(400, "missing_fields", "uf, issued, cnpj, model, series e number são obrigatórios.");
  }

  try {
    const key = buildAccessKey({
      uf,
      issued,
      cnpj,
      model,
      series,
      number,
      emissionType: text(body.emissionType),
      randomCode: text(body.randomCode),
    });
    // Devolve já decodificada: quem monta a chave costuma querer conferir o que saiu.
    return json({ key, details: parseAccessKey(key) }, 201);
  } catch (err) {
    if (err instanceof NfeError) return apiError(400, err.code, err.message);
    throw err;
  }
});
