import { businessDays, parseIsoDate } from "../../../lib/holidays.js";
import { apiError, json } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

const MAX_DAYS = 3660;

/** GET /v1/holidays/business-days?from=2026-10-01&to=2026-10-31 — conta dias úteis (sem fins de semana e feriados nacionais). */
export const GET = withApi((req) => {
  const p = new URL(req.url).searchParams;
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (from === null || to === null) {
    return apiError(400, "invalid_date", "from e to devem estar no formato AAAA-MM-DD.");
  }
  if (to < from) return apiError(400, "invalid_range", "to deve ser igual ou posterior a from.");
  if ((to - from) / 86_400_000 + 1 > MAX_DAYS) {
    return apiError(400, "range_too_long", "O intervalo máximo é de 10 anos (3660 dias).");
  }
  return json(businessDays(from, to));
});
