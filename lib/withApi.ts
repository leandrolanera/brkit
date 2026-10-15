import { effectivePlan, extractKey, lookupKey, type KeyRecord } from "./auth.js";
import { apiError } from "./http.js";
import { PLANS } from "./plans.js";
import { getStore, type Store } from "./store.js";

export interface ApiContext {
  key: KeyRecord;
  store: Store;
}

export type ApiHandler = (req: Request, ctx: ApiContext) => Promise<Response> | Response;

const USAGE_TTL_SECONDS = 62 * 24 * 3600;

/**
 * Envolve um endpoint autenticado: valida a chave, aplica limite por minuto e cota mensal,
 * e só debita o uso quando a resposta é bem-sucedida (< 400).
 *
 * `cost` permite cobrar mais de uma unidade por chamada (ex.: endpoints com IA).
 * `cost: 0` marca endpoints que não consomem nem dependem da cota (ex.: cobrança):
 * continuam sujeitos ao limite por minuto, mas funcionam mesmo com a cota esgotada,
 * que é justamente quando o cliente precisa fazer upgrade.
 */
export function withApi(handler: ApiHandler, opts: { cost?: number } = {}) {
  const cost = opts.cost ?? 1;

  return async (req: Request): Promise<Response> => {
    try {
      const store = getStore();

      const raw = extractKey(req);
      if (!raw) return apiError(401, "missing_api_key", "Envie sua chave no header x-api-key.");
      const key = await lookupKey(store, raw);
      if (!key) return apiError(401, "invalid_api_key", "Chave de API inválida.");

      const plan = PLANS[effectivePlan(key)];
      const now = new Date();

      const minute = Math.floor(now.getTime() / 60_000);
      const rlKey = `rl:${key.id}:${minute}`;
      const hits = await store.incr(rlKey);
      if (hits === 1) await store.expire(rlKey, 120);
      if (hits > plan.perMinute) {
        return apiError(429, "rate_limited", "Limite de requisições por minuto excedido.", {
          "retry-after": String(60 - now.getUTCSeconds()),
          "x-ratelimit-limit": String(plan.perMinute),
          "x-ratelimit-remaining": "0",
        });
      }

      const usageKey = `usage:${key.id}:${now.toISOString().slice(0, 7)}`;
      const used = (await store.get<number>(usageKey)) ?? 0;
      if (cost > 0 && used + cost > plan.monthlyQuota) {
        return apiError(402, "quota_exceeded", "Cota mensal do plano esgotada.", {
          "x-usage-limit": String(plan.monthlyQuota),
          "x-usage-remaining": "0",
        });
      }

      const res = await handler(req, { key, store });

      let usedNow = used;
      if (cost > 0 && res.status < 400) {
        usedNow = await store.incrBy(usageKey, cost);
        if (usedNow === cost) await store.expire(usageKey, USAGE_TTL_SECONDS);
      }

      const headers = new Headers(res.headers);
      headers.set("x-ratelimit-limit", String(plan.perMinute));
      headers.set("x-ratelimit-remaining", String(Math.max(0, plan.perMinute - hits)));
      headers.set("x-usage-limit", String(plan.monthlyQuota));
      headers.set("x-usage-remaining", String(Math.max(0, plan.monthlyQuota - usedNow)));
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (err) {
      console.error("unhandled_error", err);
      return apiError(500, "internal_error", "Erro interno.");
    }
  };
}
