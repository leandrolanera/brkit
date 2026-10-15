import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { asaasConfigFromEnv, AsaasError, createAsaasClient } from "../lib/asaas.js";
import { createApiKey, effectivePlan, getKeyRecordById, type KeyRecord } from "../lib/auth.js";
import {
  BillingError,
  cancelSubscription,
  getBillingStatus,
  handleAsaasEvent,
  startCheckout,
  todayInBrazil,
  type AsaasEvent,
} from "../lib/billing.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as webhook } from "../api/webhooks/asaas.js";
import { POST as checkout } from "../api/v1/billing/checkout.js";
import { DELETE as cancelEndpoint, GET as statusEndpoint } from "../api/v1/billing/index.js";
import { call, jsonBody, withEnv } from "./helpers.js";

interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

/** Asaas simulado: responde às rotas usadas pela cobrança e registra o que recebeu. */
function fakeAsaas(opts: { failCustomer?: boolean } = {}) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, headers, body });
    const respond = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (method === "POST" && url.endsWith("/customers")) {
      return opts.failCustomer
        ? respond(400, { errors: [{ code: "invalid_customer", description: "CPF/CNPJ inválido" }] })
        : respond(200, { id: "cus_1" });
    }
    if (method === "POST" && url.endsWith("/subscriptions")) {
      return respond(200, { id: "sub_1", status: "ACTIVE", paymentLink: null });
    }
    if (method === "GET" && url.includes("/subscriptions/sub_1/payments")) {
      return respond(200, { data: [{ id: "pay_1", status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/abc" }] });
    }
    if (method === "DELETE" && url.endsWith("/subscriptions/sub_1")) return respond(200, { deleted: true, id: "sub_1" });
    return respond(404, { errors: [{ code: "not_found", description: "rota inesperada" }] });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

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

const NOW = new Date("2026-10-15T15:00:00Z");

const customer = { name: "Maria Souza", document: "52998224725", email: "maria@exemplo.com.br" };

async function newKey(): Promise<{ key: string; record: KeyRecord }> {
  return createApiKey(store, "teste", "free");
}

function paymentEvent(
  id: string,
  event: string,
  extra: { subscription?: string; dueDate?: string; dateCreated?: string } = {},
): AsaasEvent {
  return {
    id,
    event,
    dateCreated: extra.dateCreated ?? "2026-10-15 10:00:00",
    payment: { id: "pay_1", subscription: extra.subscription ?? "sub_1", dueDate: extra.dueDate ?? "2026-10-15" },
  };
}

// --- cliente Asaas ---------------------------------------------------------

test("configuração: sem chave desliga, sandbox por padrão, produção só se pedida", () => {
  restoreEnv = withEnv({ ASAAS_API_KEY: undefined, ASAAS_ENV: undefined });
  assert.equal(asaasConfigFromEnv(), null);

  restoreEnv();
  restoreEnv = withEnv({ ASAAS_API_KEY: "k", ASAAS_ENV: undefined });
  assert.equal(asaasConfigFromEnv()?.baseUrl, "https://api-sandbox.asaas.com/v3");

  restoreEnv();
  restoreEnv = withEnv({ ASAAS_API_KEY: "k", ASAAS_ENV: "production" });
  assert.equal(asaasConfigFromEnv()?.baseUrl, "https://api.asaas.com/v3");
});

test("cliente envia access_token e User-Agent; erro vira AsaasError com os detalhes", async () => {
  const fake = fakeAsaas({ failCustomer: true });
  const client = createAsaasClient({ apiKey: "chave-teste", baseUrl: "https://api-sandbox.asaas.com/v3", fetchImpl: fake.fetchImpl });

  await assert.rejects(
    client.createCustomer({ name: "x", cpfCnpj: "1", email: "a@b.c", externalReference: "k" }),
    (err: unknown) =>
      err instanceof AsaasError && err.status === 400 && err.details[0]?.description === "CPF/CNPJ inválido",
  );
  const sent = fake.calls[0]!;
  assert.equal(sent.url, "https://api-sandbox.asaas.com/v3/customers");
  assert.equal(sent.headers["access_token"], "chave-teste");
  assert.match(sent.headers["user-agent"] ?? "", /^apis-portfolio\//);
});

// --- checkout e cancelamento -----------------------------------------------

test("checkout cria cliente e assinatura mensal e devolve o link da fatura", async () => {
  const fake = fakeAsaas();
  const asaas = createAsaasClient({ apiKey: "k", baseUrl: "https://x/v3", fetchImpl: fake.fetchImpl });
  const { record } = await newKey();

  const result = await startCheckout({ store, asaas, now: NOW, successUrl: "https://app.exemplo.com.br/ok" }, record, {
    plan: "pro",
    customer,
  });

  assert.deepEqual(result, {
    subscription_id: "sub_1",
    plan: "pro",
    price_brl: 49,
    payment_url: "https://sandbox.asaas.com/i/abc",
  });
  const [createCustomer, createSubscription] = fake.calls;
  assert.deepEqual(createCustomer?.body, {
    name: "Maria Souza",
    cpfCnpj: "52998224725",
    email: "maria@exemplo.com.br",
    externalReference: record.id,
  });
  assert.equal(createSubscription?.body?.["billingType"], "UNDEFINED");
  assert.equal(createSubscription?.body?.["cycle"], "MONTHLY");
  assert.equal(createSubscription?.body?.["value"], 49);
  assert.equal(createSubscription?.body?.["customer"], "cus_1");
  assert.equal(createSubscription?.body?.["externalReference"], record.id);
  assert.equal(createSubscription?.body?.["nextDueDate"], "2026-10-15");
  assert.deepEqual(createSubscription?.body?.["callback"], { successUrl: "https://app.exemplo.com.br/ok", autoRedirect: true });
});

test("data de vencimento usa o dia de São Paulo, não o UTC", () => {
  assert.equal(todayInBrazil(new Date("2026-10-16T01:30:00Z")), "2026-10-15");
  assert.equal(todayInBrazil(new Date("2026-10-16T03:00:00Z")), "2026-10-16");
});

test("segundo checkout com assinatura ativa → 409; após cancelar, contrata de novo reaproveitando o cliente", async () => {
  const fake = fakeAsaas();
  const asaas = createAsaasClient({ apiKey: "k", baseUrl: "https://x/v3", fetchImpl: fake.fetchImpl });
  const { record } = await newKey();

  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  await assert.rejects(
    startCheckout({ store, asaas, now: NOW }, record, { plan: "scale", customer }),
    (err: unknown) => err instanceof BillingError && err.status === 409 && err.code === "subscription_exists",
  );

  const cancelled = await cancelSubscription({ store, asaas }, record);
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(
    cancelSubscription({ store, asaas }, record),
    (err: unknown) => err instanceof BillingError && err.status === 404,
  );

  await startCheckout({ store, asaas, now: NOW }, record, { plan: "scale", customer });
  assert.equal(fake.calls.filter((c) => c.url.endsWith("/customers")).length, 1);
});

// --- webhook: lógica -------------------------------------------------------

async function subscribed(plan: "pro" | "scale" = "pro") {
  const fake = fakeAsaas();
  const asaas = createAsaasClient({ apiKey: "k", baseUrl: "https://x/v3", fetchImpl: fake.fetchImpl });
  const { record } = await newKey();
  await startCheckout({ store, asaas, now: NOW }, record, { plan, customer });
  return { record, asaas };
}

test("pagamento recebido libera o plano até vencimento + 34 dias e é idempotente", async () => {
  const { record } = await subscribed();
  assert.equal((await getKeyRecordById(store, record.id))?.plan, "free");

  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED")), "processed");
  const key = await getKeyRecordById(store, record.id);
  assert.equal(key?.plan, "pro");
  assert.equal(key?.planUntil, "2026-11-18T13:00:00.000Z");
  assert.equal(effectivePlan(key!, Date.parse("2026-11-10T00:00:00Z")), "pro");
  assert.equal(effectivePlan(key!, Date.parse("2026-11-19T00:00:00Z")), "free");

  // mesmo evento reenviado
  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED")), "duplicate");
  // boleto/cartão: CONFIRMED e depois RECEIVED, com ids diferentes e o mesmo pagamento
  await handleAsaasEvent(store, paymentEvent("evt_2", "PAYMENT_CONFIRMED"));
  await handleAsaasEvent(store, paymentEvent("evt_3", "PAYMENT_RECEIVED"));
  assert.equal((await getKeyRecordById(store, record.id))?.planUntil, "2026-11-18T13:00:00.000Z");
});

test("renovação paga adiantada continua o ciclo a partir do vencimento", async () => {
  const { record } = await subscribed();
  await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED"));
  await handleAsaasEvent(
    store,
    paymentEvent("evt_2", "PAYMENT_RECEIVED", { dueDate: "2026-11-15", dateCreated: "2026-11-10 09:00:00" }),
  );
  assert.equal((await getKeyRecordById(store, record.id))?.planUntil, "2026-12-19T00:00:00.000Z");
});

test("pagamento muito atrasado ainda libera o período inteiro", async () => {
  const { record } = await subscribed();
  await handleAsaasEvent(
    store,
    paymentEvent("evt_1", "PAYMENT_RECEIVED", { dueDate: "2026-06-01", dateCreated: "2026-10-15 10:00:00" }),
  );
  assert.equal((await getKeyRecordById(store, record.id))?.planUntil, "2026-11-18T13:00:00.000Z");
});

test("eventos sem assinatura conhecida, sem id ou irrelevantes são ignorados", async () => {
  await subscribed();
  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED", { subscription: "sub_outra" })), "ignored");
  assert.equal(await handleAsaasEvent(store, { id: "evt_2", event: "PAYMENT_RECEIVED", payment: { id: "pay_x" } }), "ignored");
  assert.equal(await handleAsaasEvent(store, { event: "PAYMENT_RECEIVED" }), "ignored");
  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_3", "PAYMENT_OVERDUE")), "ignored");
  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_4", "PAYMENT_CREATED")), "ignored");
});

test("estorno ou chargeback revoga o acesso na hora", async () => {
  const { record } = await subscribed();
  await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED"));
  const when = new Date("2026-10-20T00:00:00Z");
  assert.equal(await handleAsaasEvent(store, paymentEvent("evt_2", "PAYMENT_REFUNDED"), when), "processed");
  const key = await getKeyRecordById(store, record.id);
  assert.equal(effectivePlan(key!, when.getTime() + 1000), "free");
});

test("assinatura removida mantém o acesso pago até o fim do período e libera novo checkout", async () => {
  const { record, asaas } = await subscribed();
  await handleAsaasEvent(store, paymentEvent("evt_1", "PAYMENT_RECEIVED"));

  const outcome = await handleAsaasEvent(store, { id: "evt_2", event: "SUBSCRIPTION_DELETED", subscription: { id: "sub_1" } });
  assert.equal(outcome, "processed");

  const key = await getKeyRecordById(store, record.id);
  assert.equal(key?.plan, "pro");
  assert.equal(effectivePlan(key!, Date.parse("2026-11-10T00:00:00Z")), "pro");

  const status = await getBillingStatus({ store, asaas: null }, key!);
  assert.equal(status.subscription?.status, "cancelled");
  assert.equal(status.plan_until, "2026-11-18T13:00:00.000Z");
  await startCheckout({ store, asaas, now: NOW }, key!, { plan: "pro", customer });
});

// --- webhook: HTTP ---------------------------------------------------------

test("webhook: sem token configurado → 503; token errado ou ausente → 401; corpo inválido → 400", async () => {
  restoreEnv = withEnv({ ASAAS_WEBHOOK_TOKEN: undefined });
  assert.equal((await call(webhook, "/api/webhooks/asaas", undefined, jsonBody({ id: "e" }))).status, 503);

  restoreEnv();
  restoreEnv = withEnv({ ASAAS_WEBHOOK_TOKEN: "token-de-teste-com-mais-de-32-caracteres" });
  assert.equal((await call(webhook, "/api/webhooks/asaas", undefined, jsonBody({ id: "e" }))).status, 401);
  const wrong = { ...jsonBody({ id: "e" }), headers: { "asaas-access-token": "errado" } };
  assert.equal((await call(webhook, "/api/webhooks/asaas", undefined, wrong)).status, 401);

  const garbage = { method: "POST", body: "isto não é json", headers: { "asaas-access-token": "token-de-teste-com-mais-de-32-caracteres" } };
  assert.equal((await call(webhook, "/api/webhooks/asaas", undefined, garbage)).status, 400);
});

test("webhook: token correto processa o evento e responde 200 também para ignorados", async () => {
  restoreEnv = withEnv({ ASAAS_WEBHOOK_TOKEN: "token-de-teste-com-mais-de-32-caracteres" });
  const { record } = await subscribed();
  const headers = { "content-type": "application/json", "asaas-access-token": "token-de-teste-com-mais-de-32-caracteres" };

  const ok = await call(webhook, "/api/webhooks/asaas", undefined, {
    method: "POST",
    headers,
    body: JSON.stringify(paymentEvent("evt_1", "PAYMENT_RECEIVED")),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { received: true, outcome: "processed" });
  assert.equal((await getKeyRecordById(store, record.id))?.plan, "pro");

  const ignored = await call(webhook, "/api/webhooks/asaas", undefined, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: "evt_2", event: "TRANSFER_DONE" }),
  });
  assert.equal(ignored.status, 200);
  assert.deepEqual(await ignored.json(), { received: true, outcome: "ignored" });
});

// --- endpoints /v1/billing -------------------------------------------------

test("billing indisponível sem ASAAS_API_KEY → 503", async () => {
  restoreEnv = withEnv({ ASAAS_API_KEY: undefined });
  const { key } = await newKey();
  const res = await call(checkout, "/v1/billing/checkout", key, jsonBody({ plan: "pro", customer }));
  assert.equal(res.status, 503);
});

test("checkout valida plano, nome, e-mail e documento", async () => {
  restoreEnv = withEnv({ ASAAS_API_KEY: "chave-teste" });
  const fake = fakeAsaas();
  globalThis.fetch = fake.fetchImpl;
  const { key } = await newKey();
  const post = (body: unknown) => call(checkout, "/v1/billing/checkout", key, jsonBody(body));

  assert.equal((await post({ plan: "free", customer })).status, 400);
  assert.equal((await post({ plan: "pro", customer: { ...customer, name: "x" } })).status, 400);
  assert.equal((await post({ plan: "pro", customer: { ...customer, email: "sem-arroba" } })).status, 400);
  assert.equal((await post({ plan: "pro", customer: { ...customer, document: "111.111.111-11" } })).status, 400);
  assert.equal(fake.calls.length, 0);
});

test("checkout pelo endpoint: 201 com link, não gasta cota e funciona com a cota esgotada", async () => {
  restoreEnv = withEnv({ ASAAS_API_KEY: "chave-teste" });
  const fake = fakeAsaas();
  globalThis.fetch = fake.fetchImpl;
  const { key, record } = await newKey();
  const month = new Date().toISOString().slice(0, 7);
  await store.set(`usage:${record.id}:${month}`, 1000);

  const res = await call(checkout, "/v1/billing/checkout", key, jsonBody({ plan: "pro", customer: { ...customer, document: "529.982.247-25" } }));
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { payment_url: string }).payment_url, "https://sandbox.asaas.com/i/abc");
  assert.equal(fake.calls[0]?.body?.["cpfCnpj"], "52998224725");
  assert.equal(fake.calls[0]?.headers["access_token"], "chave-teste");
  assert.equal(await store.get(`usage:${record.id}:${month}`), 1000);

  const again = await call(checkout, "/v1/billing/checkout", key, jsonBody({ plan: "pro", customer }));
  assert.equal(again.status, 409);

  const status = await call(statusEndpoint, "/v1/billing", key);
  assert.equal(status.status, 200);
  const body = (await status.json()) as {
    plan: string;
    subscription: { status: string };
    pending_payment_url: string;
    usage: { used: number; limit: number };
  };
  assert.equal(body.plan, "free");
  assert.equal(body.subscription.status, "active");
  assert.equal(body.pending_payment_url, "https://sandbox.asaas.com/i/abc");
  assert.deepEqual(body.usage, { month, used: 1000, limit: 1000 });

  const cancelled = await call(cancelEndpoint, "/v1/billing", key, { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.equal((await call(cancelEndpoint, "/v1/billing", key, { method: "DELETE" })).status, 404);
});

test("Asaas rejeitando os dados (400) → 422 com o motivo; falha do Asaas (500) → 502 sem detalhes internos", async () => {
  restoreEnv = withEnv({ ASAAS_API_KEY: "chave-teste" });
  const { key } = await newKey();

  globalThis.fetch = fakeAsaas({ failCustomer: true }).fetchImpl;
  const rejected = await call(checkout, "/v1/billing/checkout", key, jsonBody({ plan: "pro", customer }));
  assert.equal(rejected.status, 422);
  assert.match(await rejected.text(), /CPF\/CNPJ inválido/);

  globalThis.fetch = (async () => new Response("erro interno do provedor", { status: 500 })) as typeof fetch;
  const down = await call(checkout, "/v1/billing/checkout", key, jsonBody({ plan: "pro", customer }));
  assert.equal(down.status, 502);
  assert.doesNotMatch(await down.text(), /erro interno do provedor/);
});
