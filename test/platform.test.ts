import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createApiKey, effectivePlan, updateKeyPlan } from "../lib/auth.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { withApi } from "../lib/withApi.js";
import { GET as holidays } from "../api/v1/holidays/index.js";
import { GET as businessDays } from "../api/v1/holidays/business-days.js";
import { POST as cpf } from "../api/v1/validate/cpf.js";
import { GET as cnpjGet } from "../api/v1/validate/cnpj.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

test("sem chave → 401; chave inválida → 401", async () => {
  assert.equal((await call(holidays, "/v1/holidays")).status, 401);
  assert.equal((await call(holidays, "/v1/holidays", "ak_live_nope")).status, 401);
});

test("chave válida → 200 com cabeçalhos de uso, e a cota é debitada", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  const res = await call(holidays, "/v1/holidays?year=2026", key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-usage-limit"), "1000");
  assert.equal(res.headers.get("x-usage-remaining"), "999");
  assert.equal(res.headers.get("x-ratelimit-limit"), "10");
  const body = (await res.json()) as { holidays: unknown[] };
  assert.ok(body.holidays.length >= 12);
});

test("Bearer também é aceito", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  const res = await holidays(new Request("https://api.test/v1/holidays", { headers: { authorization: `Bearer ${key}` } }));
  assert.equal(res.status, 200);
});

test("erro de validação (400) não consome a cota", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  const bad = await call(holidays, "/v1/holidays?year=abc", key);
  assert.equal(bad.status, 400);
  const ok = await call(holidays, "/v1/holidays", key);
  assert.equal(ok.headers.get("x-usage-remaining"), "999");
});

test("limite por minuto → 429 na 11ª chamada do plano free", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  for (let i = 0; i < 10; i++) assert.equal((await call(holidays, "/v1/holidays", key)).status, 200);
  const res = await call(holidays, "/v1/holidays", key);
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
});

test("cota mensal esgotada → 402", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const month = new Date().toISOString().slice(0, 7);
  await store.set(`usage:${record.id}:${month}`, 1000);
  assert.equal((await call(holidays, "/v1/holidays", key)).status, 402);
});

/** Store que registra as chamadas, para inspecionar reservas, estornos e TTL. */
function spyStore(inner: Store): { store: Store; calls: string[] } {
  const calls: string[] = [];
  const store: Store = {
    async get<T>(key: string) {
      calls.push(`get ${key}`);
      return inner.get<T>(key);
    },
    async set(key, value, opts) {
      calls.push(`set ${key}`);
      return inner.set(key, value, opts);
    },
    async incr(key) {
      calls.push(`incr ${key}`);
      return inner.incr(key);
    },
    async incrBy(key, amount) {
      calls.push(`incrBy ${key} ${amount}`);
      return inner.incrBy(key, amount);
    },
    async expire(key, seconds) {
      calls.push(`expire ${key} ${seconds}`);
      return inner.expire(key, seconds);
    },
  };
  return { store, calls };
}

const usageMonth = () => new Date().toISOString().slice(0, 7);

test("chamadas simultâneas na borda da cota não furam o limite", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;
  await store.set(usage, 999);

  // Ler e só depois incrementar deixaria as duas passarem pela mesma verificação.
  const [a, b] = await Promise.all([call(holidays, "/v1/holidays", key), call(holidays, "/v1/holidays", key)]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 402]);
  assert.equal(await store.get(usage), 1000, "a cota não pode passar do limite do plano");
});

test("402 por cota estourada estorna a reserva e não deixa resíduo", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;
  await store.set(usage, 1000);

  const res = await call(holidays, "/v1/holidays", key);
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("x-usage-remaining"), "0");
  assert.equal(await store.get(usage), 1000, "a reserva recusada precisa voltar");
});

test("resposta 4xx do handler estorna a reserva", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;
  const failing = withApi(() => new Response("nope", { status: 400 }), { cost: 3 });

  const res = await call(failing, "/x", key);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("x-usage-remaining"), "1000");
  // O que importa é não ter consumido nada; a chave pode nem existir (nunca debitada)
  // ou existir zerada (debitada e estornada) — as duas formas satisfazem o contrato.
  assert.equal((await store.get<number>(usage)) ?? 0, 0, "nenhuma unidade pode ser consumida");
});

test("handler que quebra (500) estorna a reserva", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;
  const broken = withApi(() => {
    throw new Error("falha no meio");
  }, { cost: 4 });

  assert.equal((await call(broken, "/x", key)).status, 500);
  assert.equal((await store.get<number>(usage)) ?? 0, 0, "a reserva não usada precisa voltar");
});

test("a reserva é integral: cost que não cabe na cota não debita nada", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;
  await store.set(usage, 998);
  const costly = withApi(() => new Response("ok"), { cost: 5 });

  assert.equal((await call(costly, "/x", key)).status, 402);
  assert.equal(await store.get(usage), 998, "não existe débito parcial");
});

test("o primeiro débito do mês define o TTL da chave de uso", async () => {
  const inner = createMemoryStore();
  const { store: spy, calls } = spyStore(inner);
  setStore(spy);
  const { key, record } = await createApiKey(inner, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;

  await call(holidays, "/v1/holidays", key);
  assert.ok(
    calls.includes(`expire ${usage} ${62 * 24 * 3600}`),
    "o TTL precisa ser definido no primeiro débito",
  );

  calls.length = 0;
  await call(holidays, "/v1/holidays", key);
  assert.ok(
    !calls.some((c) => c.startsWith(`expire ${usage}`)),
    "o TTL não deve ser redefinido nas chamadas seguintes",
  );
});

test("cost 0 não reserva nem estorna", async () => {
  const inner = createMemoryStore();
  const { store: spy, calls } = spyStore(inner);
  setStore(spy);
  const { key, record } = await createApiKey(inner, "teste", "free");
  const usage = `usage:${record.id}:${usageMonth()}`;

  const free = withApi(() => new Response("ok"), { cost: 0 });
  assert.equal((await call(free, "/x", key)).status, 200);
  assert.ok(!calls.some((c) => c.startsWith(`incrBy ${usage}`)), "cost 0 não mexe no contador");
});

test("cost maior que 1 debita várias unidades", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  const costly = withApi(() => new Response("ok"), { cost: 5 });
  const res = await call(costly, "/x", key);
  assert.equal(res.headers.get("x-usage-remaining"), "995");
});

test("cost 0 funciona com a cota esgotada e não debita", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  const month = new Date().toISOString().slice(0, 7);
  await store.set(`usage:${record.id}:${month}`, 1000);
  const free = withApi(() => new Response("ok"), { cost: 0 });
  const res = await call(free, "/x", key);
  assert.equal(res.status, 200);
  assert.equal(await store.get(`usage:${record.id}:${month}`), 1000);
});

test("erro inesperado vira 500 sem vazar detalhes", async () => {
  const { key } = await createApiKey(store, "teste", "free");
  const broken = withApi(() => {
    throw new Error("segredo interno");
  });
  const res = await call(broken, "/x", key);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.match(text, /internal_error/);
  assert.doesNotMatch(text, /segredo/);
});

test("plano pago vigente usa os limites do plano; vencido volta ao free", async () => {
  const { key, record } = await createApiKey(store, "teste", "free");
  await updateKeyPlan(store, record.id, { plan: "pro", planUntil: new Date(Date.now() + 86_400_000).toISOString() });
  const paid = await call(holidays, "/v1/holidays", key);
  assert.equal(paid.headers.get("x-ratelimit-limit"), "120");
  assert.equal(paid.headers.get("x-usage-limit"), "50000");

  await updateKeyPlan(store, record.id, { plan: "pro", planUntil: new Date(Date.now() - 1000).toISOString() });
  const expired = await call(holidays, "/v1/holidays", key);
  assert.equal(expired.headers.get("x-ratelimit-limit"), "10");
  assert.equal(expired.headers.get("x-usage-limit"), "1000");
});

test("effectivePlan: free, pago sem vencimento (manual), pago vigente e vencido", () => {
  const base = { id: "x", owner: "o", createdAt: "2026-01-01T00:00:00Z" } as const;
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(effectivePlan({ ...base, plan: "free" }, now), "free");
  assert.equal(effectivePlan({ ...base, plan: "pro" }, now), "pro");
  assert.equal(effectivePlan({ ...base, plan: "pro", planUntil: "2026-10-16T00:00:00Z" }, now), "pro");
  assert.equal(effectivePlan({ ...base, plan: "pro", planUntil: "2026-10-15T12:00:00Z" }, now), "free");
});

test("CPF só por POST, e o resultado é correto", async () => {
  const { key } = await createApiKey(store, "teste", "pro");
  const res = await call(cpf, "/v1/validate/cpf", key, jsonBody({ value: "529.982.247-25" }));
  assert.deepEqual(await res.json(), { valid: true, normalized: "52998224725", formatted: "529.982.247-25" });
  const bad = await call(cpf, "/v1/validate/cpf", key, jsonBody({ value: "111.111.111-11" }));
  assert.equal(((await bad.json()) as { valid: boolean }).valid, false);
});

test("CNPJ alfanumérico via GET", async () => {
  const { key } = await createApiKey(store, "teste", "pro");
  const res = await call(cnpjGet, `/v1/validate/cnpj?value=${encodeURIComponent("12.ABC.345/01DE-35")}`, key);
  assert.deepEqual(await res.json(), {
    valid: true,
    kind: "alphanumeric",
    normalized: "12ABC34501DE35",
    formatted: "12.ABC.345/01DE-35",
  });
});

test("dias úteis: intervalo válido e erros de entrada", async () => {
  const { key } = await createApiKey(store, "teste", "pro");
  const ok = await call(businessDays, "/v1/holidays/business-days?from=2026-10-01&to=2026-10-31", key);
  assert.equal(((await ok.json()) as { business_days: number }).business_days, 21);
  assert.equal((await call(businessDays, "/v1/holidays/business-days?from=2026-10-31&to=2026-10-01", key)).status, 400);
  assert.equal((await call(businessDays, "/v1/holidays/business-days?from=2026-02-30&to=2026-03-01", key)).status, 400);
  assert.equal((await call(businessDays, "/v1/holidays/business-days?from=2000-01-01&to=2026-01-01", key)).status, 400);
});
