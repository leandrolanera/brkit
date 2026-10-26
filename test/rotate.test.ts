import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApiKey, lookupKey, rotateApiKey, updateKeyPlan } from "../lib/auth.js";
import { startRecovery, startSignup, verifyRecovery, verifySignup, SignupError } from "../lib/signup.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as rotate } from "../api/v1/keys/rotate.js";
import { POST as recover } from "../api/v1/keys/recover/index.js";
import { POST as recoverVerify } from "../api/v1/keys/recover/verify.js";
import { GET as holidays } from "../api/v1/holidays/index.js";
import { POST as qrPost, GET as qrGet } from "../api/v1/qr/codes.js";
import { call, jsonBody, withEnv } from "./helpers.js";

let store: Store;
let restoreEnv: () => void = () => {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

afterEach(() => {
  restoreEnv();
  restoreEnv = () => {};
  globalThis.fetch = realFetch;
});

const EMAIL = "maria@exemplo.com.br";

function fakeSender() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const sender = {
    async send(message: { to: string; subject: string; text: string }) {
      sent.push(message);
      return { id: `e${sent.length}` };
    },
  };
  const lastCode = () => sent.at(-1)?.text.match(/\b([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/)?.[1] ?? null;
  return { sender, sent, lastCode };
}

/** Cadastra pelo fluxo público e devolve a chave emitida, já com o nome usado aqui. */
async function cadastrar(email = EMAIL) {
  const fake = fakeSender();
  await startSignup({ store, email: fake.sender }, email);
  const code = fake.lastCode();
  assert.ok(code);
  const { api_key, record } = await verifySignup({ store }, email, code);
  return { key: api_key, record };
}

describe("id da chave desacoplado do segredo", () => {
  test("o id não é mais o prefixo do hash", async () => {
    // Enquanto o id vinha do hash, trocar o segredo trocava o id — e com ele a cota, a
    // cobrança, os QR Codes e o externalReference da assinatura no Asaas.
    const { key, record } = await createApiKey(store, "teste", "free");
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(key).digest("hex");
    assert.notEqual(record.id, hash.slice(0, 12));
    assert.match(record.id, /^[0-9a-f]{12}$/, "o formato segue o mesmo, só a origem mudou");
  });

  test("ids são distintos entre chaves", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await createApiKey(store, `u${i}`, "free")).record.id);
    assert.equal(ids.size, 50);
  });

  test("chave criada com id no formato antigo continua autenticando", async () => {
    // Simula um registro gravado antes da mudança: id derivado do hash.
    const { generateKey, hashKey } = await import("../lib/auth.js");
    const key = generateKey();
    const hash = hashKey(key);
    const legado = { id: hash.slice(0, 12), plan: "pro" as const, owner: "antigo", createdAt: "2026-01-01T00:00:00Z" };
    await store.set(`key:${hash}`, legado);
    await store.set(`keyidx:${legado.id}`, hash);

    assert.deepEqual(await lookupKey(store, key), legado);
    // E pode ser rotacionada, preservando o id antigo.
    const rotated = await rotateApiKey(store, legado.id);
    assert.equal(rotated?.record.id, legado.id);
  });
});

describe("rotateApiKey", () => {
  test("emite segredo novo, revoga o antigo e preserva o id", async () => {
    const { key: antiga, record } = await createApiKey(store, "teste", "free");

    const rotated = await rotateApiKey(store, record.id);
    assert.ok(rotated);
    assert.notEqual(rotated.key, antiga);
    assert.equal(rotated.record.id, record.id, "o id é a âncora de tudo: não pode mudar");
    assert.ok(rotated.record.rotatedAt);

    assert.equal(await lookupKey(store, antiga), null, "a chave antiga precisa parar de valer");
    assert.equal((await lookupKey(store, rotated.key))?.id, record.id);
  });

  test("preserva plano e vencimento do período pago", async () => {
    const { record } = await createApiKey(store, "teste", "free");
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await updateKeyPlan(store, record.id, { plan: "scale", planUntil: until });

    const rotated = await rotateApiKey(store, record.id);
    assert.equal(rotated?.record.plan, "scale");
    assert.equal(rotated?.record.planUntil, until, "quem pagou não perde o acesso ao rotacionar");
  });

  test("preserva a cota já consumida no mês", async () => {
    const { key: antiga, record } = await createApiKey(store, "teste", "free");
    // Gasta 3 chamadas.
    for (let i = 0; i < 3; i++) await call(holidays, "/v1/holidays", antiga);

    const rotated = await rotateApiKey(store, record.id);
    assert.ok(rotated);
    const res = await call(holidays, "/v1/holidays", rotated.key);
    assert.equal(res.headers.get("x-usage-remaining"), "996", "rotacionar não pode zerar a cota");
  });

  test("preserva os QR Codes do dono", async () => {
    const { key: antiga, record } = await createApiKey(store, "teste", "pro");
    const criado = await call(qrPost, "/v1/qr/codes", antiga, jsonBody({ url: "https://exemplo.com.br" }));
    const { id } = (await criado.json()) as { id: string };

    const rotated = await rotateApiKey(store, record.id);
    assert.ok(rotated);
    const consulta = await call(qrGet, `/v1/qr/codes?id=${id}`, rotated.key);
    assert.equal(consulta.status, 200, "os QR Codes são ligados ao id, que foi preservado");
  });

  test("o registro de cobrança continua ligado à chave", async () => {
    const { record } = await createApiKey(store, "teste", "free");
    await store.set(`billing:key:${record.id}`, { subscriptionId: "sub_1", plan: "pro", status: "active", createdAt: "x" });

    const rotated = await rotateApiKey(store, record.id);
    assert.ok(rotated);
    const billing = await store.get<{ subscriptionId: string }>(`billing:key:${rotated.record.id}`);
    assert.equal(billing?.subscriptionId, "sub_1", "a assinatura não pode ficar órfã");
  });

  test("id inexistente devolve null", async () => {
    assert.equal(await rotateApiKey(store, "naoexiste123"), null);
  });

  test("rotacionar duas vezes revoga as duas anteriores", async () => {
    const { key: primeira, record } = await createApiKey(store, "teste", "free");
    const segunda = await rotateApiKey(store, record.id);
    const terceira = await rotateApiKey(store, record.id);

    assert.equal(await lookupKey(store, primeira), null);
    assert.equal(await lookupKey(store, segunda!.key), null);
    assert.equal((await lookupKey(store, terceira!.key))?.id, record.id);
  });
});

describe("POST /v1/keys/rotate", () => {
  test("devolve a chave nova e invalida a que autenticou a chamada", async () => {
    const { key: antiga } = await cadastrar();

    const res = await call(rotate, "/v1/keys/rotate", antiga, { method: "POST" });
    assert.equal(res.status, 200);
    const out = (await res.json()) as { api_key: string; key_id: string; owner: string };
    assert.notEqual(out.api_key, antiga);
    assert.equal(out.owner, EMAIL);

    assert.equal((await call(holidays, "/v1/holidays", antiga)).status, 401, "a antiga morre na hora");
    assert.equal((await call(holidays, "/v1/holidays", out.api_key)).status, 200);
  });

  test("exige autenticação", async () => {
    assert.equal((await call(rotate, "/v1/keys/rotate", undefined, { method: "POST" })).status, 401);
  });

  test("não consome cota e funciona com a cota esgotada", async () => {
    const { key, record } = await cadastrar();
    const month = new Date().toISOString().slice(0, 7);
    await store.set(`usage:${record.id}:${month}`, 1000);

    const res = await call(rotate, "/v1/keys/rotate", key, { method: "POST" });
    assert.equal(res.status, 200, "rotacionar por suspeita de vazamento não pode depender de cota");
    assert.equal(await store.get(`usage:${record.id}:${month}`), 1000);
  });
});

describe("recuperação por e-mail", () => {
  test("ciclo completo: perde a chave, recupera e a antiga morre", async () => {
    const { key: perdida, record } = await cadastrar();

    const fake = fakeSender();
    await startRecovery({ store, email: fake.sender }, EMAIL);
    const code = fake.lastCode();
    assert.ok(code, "quem tem chave recebe código");
    assert.match(fake.sent[0]?.text ?? "", /deixa de funcionar/, "o e-mail precisa avisar do efeito");

    const { api_key, record: novo } = await verifyRecovery({ store }, EMAIL, code);
    assert.notEqual(api_key, perdida);
    assert.equal(novo.id, record.id, "mesmo id: plano, cota, QR Codes e assinatura seguem");
    assert.equal(await lookupKey(store, perdida), null);
    assert.equal((await lookupKey(store, api_key))?.id, record.id);
  });

  test("e-mail sem chave recebe orientação, não código", async () => {
    const fake = fakeSender();
    await startRecovery({ store, email: fake.sender }, "ninguem@exemplo.com.br");

    assert.equal(fake.sent.length, 1, "ainda recebe e-mail: a resposta não pode revelar a diferença");
    assert.match(fake.sent[0]?.subject ?? "", /não há chave/i);
    assert.equal(fake.lastCode(), null);
  });

  test("verificar sem chave para o e-mail é 404", async () => {
    await assert.rejects(
      () => verifyRecovery({ store }, "ninguem@exemplo.com.br", "ABCD2345"),
      (err: unknown) => err instanceof SignupError && err.status === 404 && err.code === "no_key_for_email",
    );
  });

  test("código pendente de cadastro não serve para recuperação", async () => {
    // Nos fluxos atuais os dois códigos nunca coexistem para o mesmo e-mail: startSignup não
    // emite código se já há chave, e startRecovery não emite se não há. O armazenamento é
    // separado por propósito como defesa para quando houver um fluxo que os cruze — então o
    // teste monta o estado direto, em vez de depender de um caminho hoje inalcançável.
    const { createHash } = await import("node:crypto");
    const { key: atual } = await cadastrar();
    const hashEmail = createHash("sha256").update(EMAIL).digest("hex");
    const codigo = "ABCD2345";
    await store.set(`signup:${hashEmail}`, {
      codeHash: createHash("sha256").update(codigo).digest("hex"),
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      () => verifyRecovery({ store }, EMAIL, codigo),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
      "um código emitido para cadastro não pode rotacionar chave",
    );
    assert.ok(await lookupKey(store, atual), "e a chave em uso segue intacta");
  });

  test("código pendente de recuperação não conclui um cadastro", async () => {
    const { createHash } = await import("node:crypto");
    const email = "semchave@exemplo.com.br";
    const hashEmail = createHash("sha256").update(email).digest("hex");
    const codigo = "ABCD2345";
    await store.set(`recover:${hashEmail}`, {
      codeHash: createHash("sha256").update(codigo).digest("hex"),
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      () => verifySignup({ store }, email, codigo),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
    );
  });

  test("código errado na recuperação não mexe na chave atual", async () => {
    const { key: atual } = await cadastrar();
    const fake = fakeSender();
    await startRecovery({ store, email: fake.sender }, EMAIL);

    await assert.rejects(
      () => verifyRecovery({ store }, EMAIL, "ZZZZZZZZ"),
      (err: unknown) => err instanceof SignupError && err.code === "invalid_code",
    );
    assert.ok(await lookupKey(store, atual), "errar o código não pode derrubar a chave de quem está usando");
  });

  test("o código de recuperação é de uso único", async () => {
    await cadastrar();
    const fake = fakeSender();
    await startRecovery({ store, email: fake.sender }, EMAIL);
    const code = fake.lastCode()!;

    const primeira = await verifyRecovery({ store }, EMAIL, code);
    assert.ok(primeira.api_key);

    await assert.rejects(
      () => verifyRecovery({ store }, EMAIL, code),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
      "reusar o código não pode emitir outra chave",
    );
    assert.ok(await lookupKey(store, primeira.api_key), "e a chave entregue continua valendo");
  });

  test("cinco erros invalidam o código de recuperação", async () => {
    const { key: atual } = await cadastrar();
    const fake = fakeSender();
    await startRecovery({ store, email: fake.sender }, EMAIL);
    const code = fake.lastCode()!;

    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => verifyRecovery({ store }, EMAIL, "ZZZZZZZZ"));
    }
    await assert.rejects(
      () => verifyRecovery({ store }, EMAIL, code),
      (err: unknown) => err instanceof SignupError && ["too_many_attempts", "no_pending_code"].includes(err.code),
    );
    assert.ok(await lookupKey(store, atual), "e a chave em uso segue intacta");
  });
});

describe("endpoints de recuperação", () => {
  const postRecover = (body: unknown, ip = "1.1.1.1") =>
    recover(
      new Request("https://api.test/v1/keys/recover", {
        ...jsonBody(body),
        headers: { ...(jsonBody(body).headers as Record<string, string>), "x-real-ip": ip },
      }),
    );
  const postVerify = (body: unknown, ip = "1.1.1.1") =>
    recoverVerify(
      new Request("https://api.test/v1/keys/recover/verify", {
        ...jsonBody(body),
        headers: { ...(jsonBody(body).headers as Record<string, string>), "x-real-ip": ip },
      }),
    );

  test("sem configuração de e-mail as duas rotas respondem 503", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    assert.equal((await postRecover({ email: EMAIL })).status, 503);
    assert.equal((await postVerify({ email: EMAIL, code: "ABCD2345" })).status, 503);
  });

  test("202 tanto para e-mail com chave quanto sem", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;
    await cadastrar();

    assert.equal((await postRecover({ email: EMAIL }, "5.5.5.1")).status, 202);
    assert.equal((await postRecover({ email: "ninguem@exemplo.com.br" }, "5.5.5.2")).status, 202);
  });

  test("ciclo completo pelos endpoints", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    const enviados: string[] = [];
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      enviados.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
      return new Response(JSON.stringify({ id: "e" }), { status: 200 });
    }) as typeof fetch;

    const { key: perdida } = await cadastrar();
    assert.equal((await postRecover({ email: EMAIL }, "6.6.6.6")).status, 202);
    const code = enviados.at(-1)?.match(/\b([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/)?.[1];
    assert.ok(code);

    const res = await postVerify({ email: EMAIL, code }, "6.6.6.6");
    assert.equal(res.status, 200);
    const out = (await res.json()) as { api_key: string; limits: { monthly_quota: number } };
    assert.notEqual(out.api_key, perdida);
    assert.equal(out.limits.monthly_quota, 1000);
    assert.equal((await call(holidays, "/v1/holidays", out.api_key)).status, 200);
  });

  test("entrada inválida é 400", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;
    assert.equal((await postRecover({}, "4.4.4.1")).status, 400);
    assert.equal((await postRecover({ email: "sem-arroba" }, "4.4.4.2")).status, 400);
    assert.equal((await postVerify({ email: EMAIL }, "4.4.4.3")).status, 400);
    assert.equal((await postVerify({ code: "ABCD2345" }, "4.4.4.4")).status, 400);
  });

  test("limite por e-mail barra o terceiro pedido no mesmo minuto", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;
    await cadastrar();

    assert.equal((await postRecover({ email: EMAIL }, "8.8.8.1")).status, 202);
    assert.equal((await postRecover({ email: EMAIL }, "8.8.8.2")).status, 202);
    assert.equal((await postRecover({ email: EMAIL }, "8.8.8.3")).status, 429);
  });

  test("o limite da recuperação é separado do limite do cadastro", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;
    const { POST: signupPost } = await import("../api/v1/signup/index.js");
    await cadastrar();

    // Esgota o limite da recuperação para este e-mail.
    await postRecover({ email: EMAIL }, "3.3.3.1");
    await postRecover({ email: EMAIL }, "3.3.3.2");
    assert.equal((await postRecover({ email: EMAIL }, "3.3.3.3")).status, 429);

    // O cadastro tem balde próprio e segue respondendo.
    const res = await signupPost(
      new Request("https://api.test/v1/signup", {
        ...jsonBody({ email: EMAIL }),
        headers: { ...(jsonBody({ email: EMAIL }).headers as Record<string, string>), "x-real-ip": "3.3.3.9" },
      }),
    );
    assert.equal(res.status, 202);
  });
});
