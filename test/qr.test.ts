import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { GET as qrStatic } from "../api/v1/qr/index.js";
import { GET as qrGet, PATCH as qrPatch, POST as qrPost } from "../api/v1/qr/codes.js";
import { GET as redirect } from "../api/redirect.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

test("QR estático: PNG e SVG, parâmetros inválidos → 400", async () => {
  const { key } = await createApiKey(store, "teste", "pro");
  const png = await call(qrStatic, "/v1/qr?data=https://exemplo.com.br", key);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);

  const svg = await call(qrStatic, "/v1/qr?data=oi&format=svg", key);
  assert.match(await svg.text(), /<svg/);

  assert.equal((await call(qrStatic, "/v1/qr", key)).status, 400);
  assert.equal((await call(qrStatic, "/v1/qr?data=oi&size=5", key)).status, 400);
  assert.equal((await call(qrStatic, "/v1/qr?data=oi&format=gif", key)).status, 400);
});

test("QR dinâmico: cria, redireciona, conta leituras, troca o destino e isola por dono", async () => {
  const a = await createApiKey(store, "a", "pro");
  const b = await createApiKey(store, "b", "pro");

  const created = await call(qrPost, "/v1/qr/codes", a.key, jsonBody({ url: "https://exemplo.com.br/promo" }));
  assert.equal(created.status, 201);
  const { id, short_url, image_data_url } = (await created.json()) as {
    id: string;
    short_url: string;
    image_data_url: string;
  };
  assert.match(short_url, new RegExp(`/r/${id}$`));
  assert.match(image_data_url, /^data:image\/png;base64,/);

  const hit = await redirect(new Request(`https://api.test/api/redirect?id=${id}`));
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), "https://exemplo.com.br/promo");
  await redirect(new Request(`https://api.test/api/redirect?id=${id}`));

  const info = (await (await call(qrGet, `/v1/qr/codes?id=${id}`, a.key)).json()) as { scans: number };
  assert.equal(info.scans, 2);

  const patched = await call(qrPatch, `/v1/qr/codes?id=${id}`, a.key, {
    ...jsonBody({ url: "https://exemplo.com.br/nova" }),
    method: "PATCH",
  });
  assert.equal(patched.status, 200);
  const hit2 = await redirect(new Request(`https://api.test/api/redirect?id=${id}`));
  assert.equal(hit2.headers.get("location"), "https://exemplo.com.br/nova");

  assert.equal((await call(qrGet, `/v1/qr/codes?id=${id}`, b.key)).status, 404);
  const foreign = await call(qrPatch, `/v1/qr/codes?id=${id}`, b.key, {
    ...jsonBody({ url: "https://x.com.br" }),
    method: "PATCH",
  });
  assert.equal(foreign.status, 404);
  assert.equal((await redirect(new Request("https://api.test/api/redirect?id=naoexiste"))).status, 404);
});

test("QR dinâmico rejeita destinos inseguros", async () => {
  const { key } = await createApiKey(store, "teste", "pro");
  const unsafe = [
    "javascript:alert(1)",
    "ftp://exemplo.com.br",
    "http://localhost:3000",
    "http://user:pass@exemplo.com.br",
    "https://intranet",
    "",
  ];
  for (const url of unsafe) {
    const res = await call(qrPost, "/v1/qr/codes", key, jsonBody({ url }));
    assert.equal(res.status, 400, url);
  }
});
