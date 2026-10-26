import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import { clientIp } from "../lib/http.js";
import { rateLimitPerMinute } from "../lib/rateLimit.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { createDynamicCode, scanCount } from "../lib/qr.js";
import { GET as redirect } from "../api/redirect.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

describe("rateLimitPerMinute", () => {
  const minuteA = new Date("2026-10-15T12:00:30Z");
  const minuteB = new Date("2026-10-15T12:01:00Z");

  test("libera até o limite e barra a partir dele", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await rateLimitPerMinute(store, "b", 3, minuteA);
      assert.equal(r.allowed, true, `chamada ${i} deveria passar`);
      assert.equal(r.remaining, 3 - i);
    }
    const blocked = await rateLimitPerMinute(store, "b", 3, minuteA);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  });

  test("remaining não fica negativo depois de estourar", async () => {
    for (let i = 0; i < 5; i++) await rateLimitPerMinute(store, "b", 1, minuteA);
    assert.equal((await rateLimitPerMinute(store, "b", 1, minuteA)).remaining, 0);
  });

  test("retryAfter é o que falta para a janela virar", async () => {
    assert.equal((await rateLimitPerMinute(store, "b", 1, minuteA)).retryAfter, 30);
    assert.equal((await rateLimitPerMinute(store, "c", 1, minuteB)).retryAfter, 60);
  });

  test("baldes diferentes contam separado", async () => {
    await rateLimitPerMinute(store, "um", 1, minuteA);
    assert.equal((await rateLimitPerMinute(store, "um", 1, minuteA)).allowed, false);
    assert.equal((await rateLimitPerMinute(store, "dois", 1, minuteA)).allowed, true);
  });

  test("a virada do minuto zera a contagem", async () => {
    await rateLimitPerMinute(store, "b", 1, minuteA);
    assert.equal((await rateLimitPerMinute(store, "b", 1, minuteA)).allowed, false);
    assert.equal((await rateLimitPerMinute(store, "b", 1, minuteB)).allowed, true);
  });

  test("o balde é uma chave por minuto, com TTL", async () => {
    await rateLimitPerMinute(store, "b", 5, minuteA);
    const minute = Math.floor(minuteA.getTime() / 60_000);
    assert.equal(await store.get(`b:${minute}`), 1);
  });
});

describe("clientIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    clientIp(new Request("https://api.test/r/abc", { headers }));

  test("x-vercel-forwarded-for tem precedência: não é sobrescrito por proxy sobre a Vercel", () => {
    assert.equal(
      withHeaders({
        "x-vercel-forwarded-for": "9.9.9.9",
        "x-real-ip": "2.2.2.2",
        "x-forwarded-for": "1.1.1.1",
      }),
      "9.9.9.9",
    );
  });

  test("usa x-real-ip quando não há header da Vercel", () => {
    assert.equal(withHeaders({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1" }), "2.2.2.2");
  });

  test("no x-forwarded-for usa a última entrada, não a forjável da esquerda", () => {
    assert.equal(withHeaders({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }), "203.0.113.7");
  });

  test("ignora entradas vazias e espaços", () => {
    assert.equal(withHeaders({ "x-forwarded-for": "1.1.1.1 ,  , " }), "1.1.1.1");
    assert.equal(withHeaders({ "x-real-ip": "   " , "x-forwarded-for": "1.1.1.1" }), "1.1.1.1");
  });

  test("devolve null quando nenhum header está presente", () => {
    assert.equal(withHeaders({}), null);
  });
});

describe("/r/:id: limite da rota pública", () => {
  const scan = (id: string, ip?: string) =>
    redirect(new Request(`https://api.test/api/redirect?id=${id}`, { headers: ip ? { "x-real-ip": ip } : {} }));

  test("barra com 429 depois de 60 leituras do mesmo IP", async () => {
    const { record } = await createApiKey(store, "teste", "pro");
    const id = await createDynamicCode(store, "https://exemplo.com.br", record.id);

    for (let i = 0; i < 60; i++) assert.equal((await scan(id, "1.1.1.1")).status, 302);

    const blocked = await scan(id, "1.1.1.1");
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("x-ratelimit-limit"), "60");
    assert.ok(blocked.headers.get("retry-after"));
    assert.equal(blocked.headers.get("cache-control"), "no-store");
  });

  test("o limite é por IP: um IP barrado não afeta os outros", async () => {
    const { record } = await createApiKey(store, "teste", "pro");
    const id = await createDynamicCode(store, "https://exemplo.com.br", record.id);

    for (let i = 0; i < 61; i++) await scan(id, "1.1.1.1");
    assert.equal((await scan(id, "1.1.1.1")).status, 429);
    assert.equal((await scan(id, "2.2.2.2")).status, 302);
  });

  test("a leitura barrada não é contada nem busca o código", async () => {
    const { record } = await createApiKey(store, "teste", "pro");
    const id = await createDynamicCode(store, "https://exemplo.com.br", record.id);

    for (let i = 0; i < 60; i++) await scan(id, "1.1.1.1");
    assert.equal(await scanCount(store, id), 60);

    assert.equal((await scan(id, "1.1.1.1")).status, 429);
    assert.equal(await scanCount(store, id), 60, "o 429 não pode contar como leitura");
  });

  test("varredura de ids inexistentes também é barrada", async () => {
    for (let i = 0; i < 60; i++) assert.equal((await scan(`aaaaaa${i % 10}`, "9.9.9.9")).status, 404);
    assert.equal((await scan("bbbbbbb", "9.9.9.9")).status, 429);
  });

  test("sem IP, o limite cai para por código, e não um balde global", async () => {
    const { record } = await createApiKey(store, "teste", "pro");
    const a = await createDynamicCode(store, "https://a.exemplo.com.br", record.id);
    const b = await createDynamicCode(store, "https://b.exemplo.com.br", record.id);

    for (let i = 0; i < 61; i++) await scan(a);
    assert.equal((await scan(a)).status, 429);
    assert.equal((await scan(b)).status, 302, "um código barrado não pode derrubar os outros");
  });
});
