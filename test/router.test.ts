import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import entry from "../api/index.js";
import { routes } from "../lib/router.js";

const call = (path: string, method = "GET") => entry.fetch(new Request(`https://api.test${path}`, { method }));

test("deploy tem uma única função e todos os 23 handlers registrados", () => {
  assert.deepEqual(readdirSync("api"), ["index.ts"]);
  assert.equal(Object.keys(routes).length, 23);
});

test("health atende URL pública, URL original e barra final", async () => {
  for (const path of ["/v1/health", "/api/v1/health", "/v1/health/"]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, "ok");
  }
});

test("aliases de OpenAPI preservam origem e parâmetros", async () => {
  for (const path of ["/v1/openapi.json?example=1", "/api/v1/openapi", "/api/v1/openapi.json"]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { openapi: string }).openapi, "3.1.0");
  }
});

test("rotas inválidas e métodos não suportados", async () => {
  assert.equal((await call("/v1/desconhecida")).status, 404);
  const response = await call("/v1/health", "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  const head = await call("/v1/health", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("despacho mantém corpo JSON e autenticação do webhook", async () => {
  const previous = process.env.ASAAS_WEBHOOK_TOKEN;
  process.env.ASAAS_WEBHOOK_TOKEN = "router-test-token";
  try {
    const response = await entry.fetch(new Request("https://api.test/api/webhooks/asaas", {
      method: "POST",
      headers: { "asaas-access-token": "router-test-token", "content-type": "application/json" },
      body: "invalid-json",
    }));
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_body");
  } finally {
    if (previous === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = previous;
  }
});

test("redirect público usa id do caminho e preserva query string", async () => {
  const original = routes["/api/redirect"]!;
  let received: Request | undefined;
  routes["/api/redirect"] = { GET: (request) => { received = request; return new Response(null, { status: 302 }); } };
  try {
    assert.equal((await call("/r/abc123?id=outro&extra=1")).status, 302);
    const url = new URL(received!.url);
    assert.equal(url.searchParams.get("id"), "abc123");
    assert.equal(url.searchParams.get("extra"), "1");
  } finally {
    routes["/api/redirect"] = original;
  }
});
