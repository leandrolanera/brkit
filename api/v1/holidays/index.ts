import { holidaysForYear } from "../../../lib/holidays.js";
import { apiError, intParam, json } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

/** GET /v1/holidays?year=2026 — feriados nacionais e pontos facultativos federais. */
export const GET = withApi((req) => {
  const year = intParam(new URL(req.url).searchParams.get("year"), 1970, 2100, new Date().getUTCFullYear());
  if (year === null) return apiError(400, "invalid_year", "year deve ser um inteiro entre 1970 e 2100.");
  return json({ year, scope: "national", holidays: holidaysForYear(year) }, 200, {
    "cache-control": "public, max-age=86400",
  });
});
