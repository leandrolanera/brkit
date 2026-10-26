import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createEmailSender, EmailError, emailConfigFromEnv } from "../lib/email.js";
import { lookupKey } from "../lib/auth.js";
import {
  generateCode,
  normalizeEmail,
  SignupError,
  startSignup,
  verifySignup,
} from "../lib/signup.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as signup } from "../api/v1/signup/index.js";
import { POST as signupVerify } from "../api/v1/signup/verify.js";
import { jsonBody, withEnv } from "./helpers.js";

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

/** Remetente simulado: guarda as mensagens e permite extrair o código enviado. */
function fakeSender(opts: { fail?: boolean } = {}) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const sender = {
    async send(message: { to: string; subject: string; text: string }) {
      if (opts.fail) throw new EmailError(422, "domínio não verificado");
      sent.push(message);
      return { id: `email_${sent.length}` };
    },
  };
  /** O código tem 8 caracteres do alfabeto sem ambiguidade. */
  const lastCode = () => sent.at(-1)?.text.match(/\b([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})\b/)?.[1] ?? null;
  return { sender, sent, lastCode };
}

/** Pede o código e devolve o que o e-mail trouxe. */
async function pedirCodigo() {
  const fake = fakeSender();
  await startSignup({ store, email: fake.sender }, EMAIL);
  const code = fake.lastCode();
  assert.ok(code, "o e-mail precisa conter um código legível");
  return { fake, code };
}

describe("normalizeEmail", () => {
  test("apara e minúsculas, para o mesmo e-mail ser um cadastro só", () => {
    assert.equal(normalizeEmail("  Maria@Exemplo.COM.br "), "maria@exemplo.com.br");
  });

  test("recusa o que não é e-mail", () => {
    for (const bad of ["", "   ", "sem-arroba", "a@b", "a b@c.com", "a@@b.com", null, 42, undefined]) {
      assert.equal(normalizeEmail(bad), null, `deveria recusar: ${String(bad)}`);
    }
  });

  test("recusa endereço absurdamente longo", () => {
    assert.equal(normalizeEmail(`${"x".repeat(250)}@e.com`), null);
  });
});

describe("generateCode", () => {
  test("tem 8 caracteres e evita os ambíguos", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      assert.doesNotMatch(code, /[O0I1L]/, "caractere ambíguo atrapalha quem digita");
    }
  });

  test("não repete na prática", () => {
    const vistos = new Set(Array.from({ length: 500 }, () => generateCode()));
    assert.equal(vistos.size, 500);
  });
});

describe("startSignup", () => {
  test("envia um e-mail só, para o endereço pedido, com o código", async () => {
    const { fake, code } = await pedirCodigo();

    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.to, EMAIL);
    assert.match(fake.sent[0]?.text ?? "", new RegExp(code));
    assert.match(fake.sent[0]?.text ?? "", /30 minutos/, "o prazo precisa estar no e-mail");
  });

  test("o e-mail nunca é gravado em claro", async () => {
    const { code } = await pedirCodigo();
    // Varre o que o store guardou: nem a chave nem o valor podem conter o endereço ou o código.
    const spy = createMemoryStore();
    setStore(spy);
    const fake2 = fakeSender();
    const gravado: string[] = [];
    const wrapper: Store = {
      get: (k) => { gravado.push(k); return spy.get(k); },
      set: (k, v, o) => { gravado.push(`${k}=${JSON.stringify(v)}`); return spy.set(k, v, o); },
      incr: (k) => spy.incr(k),
      incrBy: (k, n) => spy.incrBy(k, n),
      expire: (k, s) => spy.expire(k, s),
      del: (k) => spy.del(k),
    };
    await startSignup({ store: wrapper, email: fake2.sender }, EMAIL);
    const tudo = gravado.join("|");
    assert.doesNotMatch(tudo, /maria@exemplo/, "o endereço não pode ir para o Redis em claro");
    assert.ok(!tudo.includes(code), "nem o código");
  });

  test("pedir de novo invalida o código anterior", async () => {
    const primeiro = await pedirCodigo();
    const segundo = await pedirCodigo();
    assert.notEqual(segundo.code, primeiro.code);

    await assert.rejects(
      () => verifySignup({ store }, EMAIL, primeiro.code),
      (err: unknown) => err instanceof SignupError && err.code === "invalid_code",
      "o código antigo precisa deixar de valer",
    );
    assert.ok((await verifySignup({ store }, EMAIL, segundo.code)).api_key);
  });

  test("pedir de novo zera o contador de tentativas", async () => {
    await pedirCodigo();
    // Esgota as 5 tentativas do primeiro código.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => verifySignup({ store }, EMAIL, "ZZZZZZZZ"));
    }

    // Um código novo precisa vir com as tentativas renovadas; se o contador persistisse,
    // o código legítimo cairia direto em too_many_attempts.
    const segundo = await pedirCodigo();
    assert.ok((await verifySignup({ store }, EMAIL, segundo.code)).api_key);
  });

  test("normaliza o e-mail: pedir com maiúsculas e verificar em minúsculas é o mesmo cadastro", async () => {
    const fake = fakeSender();
    await startSignup({ store, email: fake.sender }, "  MARIA@Exemplo.COM.BR ");
    const code = fake.lastCode();
    assert.ok(code);

    const { record } = await verifySignup({ store }, EMAIL, code);
    assert.equal(record.owner, EMAIL, "o hash do e-mail é a identidade do cadastro");
  });

  test("o código recebe prazo de validade no Redis", async () => {
    // O TTL não dá para observar sem esperar meia hora, então o teste confere que ele foi
    // pedido ao store — é o que impede um código ficar válido para sempre.
    const inner = createMemoryStore();
    const opcoes: { key: string; exSeconds?: number }[] = [];
    const spy: Store = {
      get: (k) => inner.get(k),
      set: (k, v, o) => {
        opcoes.push({ key: k, exSeconds: o?.exSeconds });
        return inner.set(k, v, o);
      },
      incr: (k) => inner.incr(k),
      incrBy: (k, n) => inner.incrBy(k, n),
      expire: (k, sec) => inner.expire(k, sec),
      del: (k) => inner.del(k),
    };
    const fake = fakeSender();
    await startSignup({ store: spy, email: fake.sender }, EMAIL);

    const gravacao = opcoes.find((o) => o.key.startsWith("signup:"));
    assert.ok(gravacao, "o pedido pendente precisa ser gravado");
    assert.equal(gravacao.exSeconds, 30 * 60, "sem TTL o código valeria indefinidamente");
  });

  test("quem já tem chave recebe aviso, não um código novo", async () => {
    const { code } = await pedirCodigo();
    await verifySignup({ store }, EMAIL, code);

    const fake = fakeSender();
    await startSignup({ store, email: fake.sender }, EMAIL);

    assert.equal(fake.sent.length, 1, "ainda recebe e-mail: não dá para revelar a diferença pela resposta");
    assert.match(fake.sent[0]?.subject ?? "", /já existe/i);
    assert.equal(fake.lastCode(), null, "e nenhum código novo");
  });
});

describe("verifySignup", () => {
  test("código certo emite a chave, e ela funciona", async () => {
    const { code } = await pedirCodigo();

    const { api_key, record } = await verifySignup({ store }, EMAIL, code);

    assert.match(api_key, /^ak_live_[0-9a-f]{48}$/);
    assert.equal(record.owner, EMAIL);
    assert.equal(record.plan, "free");
    const encontrada = await lookupKey(store, api_key);
    assert.equal(encontrada?.id, record.id, "a chave emitida precisa autenticar de verdade");
  });

  test("aceita o código em minúsculas e com espaços", async () => {
    const { code } = await pedirCodigo();
    const { api_key } = await verifySignup({ store }, EMAIL, `  ${code.toLowerCase()} `);
    assert.ok(api_key);
  });

  test("código errado é recusado", async () => {
    await pedirCodigo();
    await assert.rejects(
      () => verifySignup({ store }, EMAIL, "ZZZZZZZZ"),
      (err: unknown) => err instanceof SignupError && err.status === 400 && err.code === "invalid_code",
    );
  });

  test("sem pedido pendente não há o que verificar", async () => {
    await assert.rejects(
      () => verifySignup({ store }, EMAIL, "ABCD2345"),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
    );
  });

  test("na sexta tentativa o código é invalidado", async () => {
    const { code } = await pedirCodigo();

    for (let i = 0; i < 5; i++) {
      await assert.rejects(
        () => verifySignup({ store }, EMAIL, "ZZZZZZZZ"),
        (err: unknown) => err instanceof SignupError && err.code === "invalid_code",
        `tentativa ${i + 1}`,
      );
    }

    await assert.rejects(
      () => verifySignup({ store }, EMAIL, "ZZZZZZZZ"),
      (err: unknown) => err instanceof SignupError && err.status === 429 && err.code === "too_many_attempts",
    );
    // E o código legítimo também deixa de valer: é preciso pedir outro.
    await assert.rejects(
      () => verifySignup({ store }, EMAIL, code),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
    );
  });

  test("tentativas simultâneas não furam o limite", async () => {
    await pedirCodigo();
    // O contador usa incr, que é atômico nos dois stores.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        verifySignup({ store }, EMAIL, "ZZZZZZZZ").then(
          () => "ok",
          (err: unknown) => (err instanceof SignupError ? err.code : "outro"),
        ),
      ),
    );
    assert.ok(results.includes("too_many_attempts"), "o excesso precisa ser barrado");
    assert.ok(!results.includes("ok"));
  });

  test("uma chave por e-mail: quem já tem não consegue outro código", async () => {
    const primeiro = await pedirCodigo();
    await verifySignup({ store }, EMAIL, primeiro.code);

    // A regra é aplicada antes: startSignup não emite código para quem já tem chave.
    const fake = fakeSender();
    await startSignup({ store, email: fake.sender }, EMAIL);
    assert.equal(fake.lastCode(), null);
    await assert.rejects(
      () => verifySignup({ store }, EMAIL, "ABCD2345"),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
    );
  });

  test("não dá para descobrir quem tem chave pela verificação", async () => {
    // Oráculo de enumeração: se a existência da chave fosse checada ANTES do código, um
    // código qualquer separaria "tem chave" (409) de "não tem" (400) — anulando a razão de
    // POST /v1/signup responder 202 nos dois casos.
    const { code } = await pedirCodigo();
    await verifySignup({ store }, EMAIL, code); // este e-mail agora TEM chave

    const comChave = await verifySignup({ store }, EMAIL, "ZZZZZZZZ").then(
      () => "ok",
      (err: unknown) => (err instanceof SignupError ? `${err.status}/${err.code}` : "outro"),
    );
    const semChave = await verifySignup({ store }, "ninguem@exemplo.com.br", "ZZZZZZZZ").then(
      () => "ok",
      (err: unknown) => (err instanceof SignupError ? `${err.status}/${err.code}` : "outro"),
    );

    assert.equal(comChave, semChave, "a resposta precisa ser indistinguível sem um código válido");
  });

  test("o código é de uso único", async () => {
    const { code } = await pedirCodigo();
    assert.ok((await verifySignup({ store }, EMAIL, code)).api_key);
    await assert.rejects(
      () => verifySignup({ store }, EMAIL, code),
      (err: unknown) => err instanceof SignupError && err.code === "no_pending_code",
    );
  });

  test("o e-mail normalizado é o mesmo cadastro", async () => {
    const { code } = await pedirCodigo();
    const { record } = await verifySignup({ store }, "  MARIA@Exemplo.com.BR ", code);
    assert.equal(record.owner, EMAIL);
  });
});

describe("lib/email: cliente do Resend", () => {
  test("envia POST para /emails com Bearer e os campos do remetente", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "abc-123" }), { status: 200 });
    }) as typeof fetch;

    const sender = createEmailSender({ apiKey: "re_teste", from: "API <nao-responda@exemplo.com.br>", fetchImpl });
    const result = await sender.send({ to: EMAIL, subject: "Assunto", text: "Corpo" });

    assert.equal(result.id, "abc-123");
    assert.equal(calls[0]?.url, "https://api.resend.com/emails");
    assert.equal(calls[0]?.init?.method, "POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers["authorization"], "Bearer re_teste");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    assert.deepEqual(body, {
      from: "API <nao-responda@exemplo.com.br>",
      to: EMAIL,
      subject: "Assunto",
      text: "Corpo",
    });
  });

  test("erro do Resend vira EmailError com a mensagem deles", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ name: "validation_error", message: "domain is not verified", statusCode: 403 }), {
        status: 403,
      })) as typeof fetch;

    const sender = createEmailSender({ apiKey: "re_teste", from: "a@b.c", fetchImpl });
    await assert.rejects(
      () => sender.send({ to: EMAIL, subject: "s", text: "t" }),
      (err: unknown) => err instanceof EmailError && err.status === 403 && err.detail === "domain is not verified",
    );
  });

  test("corpo que não é JSON não derruba o cliente", async () => {
    const fetchImpl = (async () => new Response("ok, sem json", { status: 200 })) as typeof fetch;
    const sender = createEmailSender({ apiKey: "k", from: "a@b.c", fetchImpl });
    assert.equal((await sender.send({ to: EMAIL, subject: "s", text: "t" })).id, null);
  });

  test("configuração exige as duas variáveis", () => {
    restoreEnv = withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    assert.equal(emailConfigFromEnv(), null);
    restoreEnv();

    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: undefined });
    assert.equal(emailConfigFromEnv(), null, "sem remetente não dá para enviar");
    restoreEnv();

    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    assert.deepEqual(emailConfigFromEnv(), { apiKey: "re_x", from: "a@b.c" });
  });
});

describe("POST /v1/signup", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    signup(new Request("https://api.test/v1/signup", { ...jsonBody(body), headers: { ...jsonBody(body).headers as Record<string, string>, ...headers } }));

  test("sem configuração de e-mail responde 503", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    const res = await post({ email: EMAIL });
    assert.equal(res.status, 503);
  });

  test("aceita o pedido com 202 e envia o e-mail", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    const enviados: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      enviados.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
    }) as typeof fetch;

    const res = await post({ email: EMAIL }, { "x-real-ip": "1.1.1.1" });
    assert.equal(res.status, 202);
    assert.equal(enviados.length, 1);
  });

  test("e-mail inválido é 400 e não envia nada", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    let chamadas = 0;
    globalThis.fetch = (async () => {
      chamadas++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    for (const bad of [{}, { email: "" }, { email: "sem-arroba" }, { email: 42 }]) {
      assert.equal((await post(bad, { "x-real-ip": "2.2.2.2" })).status, 400, JSON.stringify(bad));
    }
    assert.equal(chamadas, 0);
  });

  test("falha no envio responde 502, sem vazar detalhe do provedor", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 })) as typeof fetch;

    const res = await post({ email: EMAIL }, { "x-real-ip": "3.3.3.3" });
    assert.equal(res.status, 502);
    const texto = await res.text();
    assert.doesNotMatch(texto, /domain is not verified/, "detalhe de configuração não vai para o cliente");
  });

  test("limite por e-mail barra o terceiro pedido no mesmo minuto", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;

    // IPs diferentes para isolar do limite por IP.
    assert.equal((await post({ email: EMAIL }, { "x-real-ip": "10.0.0.1" })).status, 202);
    assert.equal((await post({ email: EMAIL }, { "x-real-ip": "10.0.0.2" })).status, 202);
    const terceiro = await post({ email: EMAIL }, { "x-real-ip": "10.0.0.3" });
    assert.equal(terceiro.status, 429, "não dá para usar o cadastro para inundar uma caixa");
    assert.ok(terceiro.headers.get("retry-after"));
  });

  test("limite por IP barra o sexto pedido, mesmo com e-mails diferentes", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })) as typeof fetch;

    for (let i = 0; i < 5; i++) {
      assert.equal((await post({ email: `u${i}@exemplo.com.br` }, { "x-real-ip": "9.9.9.9" })).status, 202);
    }
    assert.equal((await post({ email: "u6@exemplo.com.br" }, { "x-real-ip": "9.9.9.9" })).status, 429);
  });
});

describe("POST /v1/signup/verify", () => {
  const post = (body: unknown, ip = "1.1.1.1") =>
    signupVerify(
      new Request("https://api.test/v1/signup/verify", {
        ...jsonBody(body),
        headers: { ...(jsonBody(body).headers as Record<string, string>), "x-real-ip": ip },
      }),
    );

  test("ciclo completo: pede, verifica e recebe a chave uma única vez", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    const { code } = await pedirCodigo();

    const res = await post({ email: EMAIL, code });
    assert.equal(res.status, 201);
    const out = (await res.json()) as { api_key: string; plan: string; limits: { monthly_quota: number } };
    assert.match(out.api_key, /^ak_live_/);
    assert.equal(out.plan, "free");
    assert.equal(out.limits.monthly_quota, 1000);

    // Repetir não emite outra chave: o código foi consumido.
    const repetido = await post({ email: EMAIL, code });
    assert.equal(repetido.status, 400);
    assert.equal(((await repetido.json()) as { error: { code: string } }).error.code, "no_pending_code");
  });

  test("entrada incompleta é 400", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    for (const bad of [{}, { email: EMAIL }, { code: "ABCD2345" }, { email: "x", code: "y" }, { email: EMAIL, code: "x".repeat(40) }]) {
      assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    }
  });

  test("sem configuração de e-mail responde 503, não 'código inválido'", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: undefined, EMAIL_FROM: undefined });
    const res = await post({ email: EMAIL, code: "ABCD2345" });
    assert.equal(res.status, 503, "quem nunca pôde receber código não deve ver erro de código");
  });

  test("limite por IP barra a décima primeira tentativa", async () => {
    restoreEnv = withEnv({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.c" });
    for (let i = 0; i < 10; i++) {
      const res = await post({ email: `u${i}@exemplo.com.br`, code: "ZZZZZZZZ" }, "7.7.7.7");
      assert.notEqual(res.status, 429, `tentativa ${i + 1}`);
    }
    assert.equal((await post({ email: EMAIL, code: "ZZZZZZZZ" }, "7.7.7.7")).status, 429);
  });
});
