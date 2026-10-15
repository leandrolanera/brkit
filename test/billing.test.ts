import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { asaasConfigFromEnv, AsaasError, createAsaasClient, type AsaasPayment } from "../lib/asaas.js";
import { createApiKey, effectivePlan, getKeyRecordById, updateKeyPlan, type KeyRecord } from "../lib/auth.js";
import {
  BillingError,
  cancelSubscription,
  getBillingStatus,
  handleAsaasEvent,
  reconcileSubscription,
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

/**
 * Asaas simulado, com estado: guarda os clientes e as assinaturas criadas e responde às
 * consultas por `externalReference` com o que de fato existe.
 *
 * O estado é o que dá sentido aos testes de recuperação: um fake sem memória responderia
 * "nada encontrado" para a consulta que existe justamente para achar a assinatura órfã.
 */
function fakeAsaas(
  opts: {
    failCustomer?: boolean;
    /** Cria a assinatura no Asaas e perde a resposta, uma vez: simula timeout após o commit. */
    dropFirstSubscriptionResponse?: boolean;
    /** Faz a consulta de assinaturas falhar, para checar que o checkout falha fechando. */
    failSubscriptionList?: boolean;
    /** Faz a consulta de clientes falhar, que não deve interromper o checkout. */
    failCustomerList?: boolean;
    /** Faz a consulta de cobranças falhar, para checar que o status não quebra. */
    failPaymentList?: boolean;
  } = {},
) {
  let dropped = false;
  /** Mutável: permite ligar a falha depois de montar o estado, no meio do teste. */
  const fail = {
    subscriptionList: opts.failSubscriptionList ?? false,
    customerList: opts.failCustomerList ?? false,
    paymentList: opts.failPaymentList ?? false,
  };
  const calls: FakeCall[] = [];
  const customers = new Map<string, { id: string; ref: string; deleted: boolean }>();
  const subscriptions = new Map<string, { id: string; ref: string; value: number; status: string; deleted: boolean }>();
  /** Cobranças por assinatura. Cada assinatura nasce com uma PENDING, como no Asaas. */
  const payments = new Map<string, AsaasPayment[]>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input);
    const url = new URL(raw);
    const path = url.pathname.replace(/^\/v3/, "");
    const ref = url.searchParams.get("externalReference");
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url: raw, headers, body });

    const respond = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (method === "GET" && path === "/customers") {
      if (fail.customerList) return respond(500, { errors: [] });
      return respond(200, { data: [...customers.values()].filter((c) => c.ref === ref && !c.deleted) });
    }

    if (method === "POST" && path === "/customers") {
      if (opts.failCustomer) {
        return respond(400, { errors: [{ code: "invalid_customer", description: "CPF/CNPJ inválido" }] });
      }
      const id = `cus_${customers.size + 1}`;
      customers.set(id, { id, ref: String(body?.["externalReference"] ?? ""), deleted: false });
      return respond(200, { id });
    }

    if (method === "GET" && path === "/subscriptions") {
      if (fail.subscriptionList) return respond(500, { errors: [] });
      // Devolve também as removidas e inativas. Não está documentado que o Asaas as exclua da
      // listagem, então descartá-las é responsabilidade do nosso código — e só assim esse
      // filtro fica de fato coberto pelos testes.
      return respond(200, { data: [...subscriptions.values()].filter((sub) => sub.ref === ref) });
    }

    if (method === "POST" && path === "/subscriptions") {
      const id = `sub_${subscriptions.size + 1}`;
      subscriptions.set(id, {
        id,
        ref: String(body?.["externalReference"] ?? ""),
        value: Number(body?.["value"] ?? 0),
        status: "ACTIVE",
        deleted: false,
      });
      payments.set(id, [{ id: `pay_${id}`, status: "PENDING", invoiceUrl: "https://sandbox.asaas.com/i/abc" }]);
      if (opts.dropFirstSubscriptionResponse && !dropped) {
        dropped = true;
        // O Asaas já criou e vai cobrar; só a resposta não chega até nós.
        throw new TypeError("fetch failed");
      }
      return respond(200, { id, status: "ACTIVE", paymentLink: null });
    }

    const paymentsRoute = path.match(/^\/subscriptions\/([^/]+)\/payments$/);
    if (method === "GET" && paymentsRoute) {
      const subId = paymentsRoute[1]!;
      if (!subscriptions.has(subId)) {
        return respond(404, { errors: [{ code: "not_found", description: "assinatura inexistente" }] });
      }
      if (fail.paymentList) return respond(500, { errors: [] });
      const wanted = url.searchParams.get("status");
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const all = payments.get(subId) ?? [];
      const filtered = wanted ? all.filter((pay) => pay.status === wanted) : all;
      return respond(200, { data: filtered.slice(0, limit) });
    }

    const one = path.match(/^\/subscriptions\/([^/]+)$/);
    if (method === "DELETE" && one) {
      const sub = subscriptions.get(one[1]!);
      if (!sub) return respond(404, { errors: [{ code: "not_found", description: "assinatura inexistente" }] });
      // Remover no Asaas tem de refletir na consulta: é o que permite contratar de novo.
      sub.deleted = true;
      sub.status = "INACTIVE";
      return respond(200, { deleted: true, id: sub.id });
    }

    return respond(404, { errors: [{ code: "not_found", description: `rota inesperada: ${method} ${path}` }] });
  }) as typeof fetch;

  /** Chamadas de um método e caminho, para não depender da ordem das requisições. */
  const callsTo = (method: string, path: string) =>
    calls.filter((c) => c.method === method && new URL(c.url).pathname.replace(/^\/v3/, "") === path);

  return { fetchImpl, calls, callsTo, customers, subscriptions, payments, fail };
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

/** Cliente do Asaas apontado para um fake. */
function client(fake: { fetchImpl: typeof fetch }) {
  return createAsaasClient({ apiKey: "k", baseUrl: "https://x/v3", fetchImpl: fake.fetchImpl });
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
  const createCustomer = fake.callsTo("POST", "/customers")[0];
  const createSubscription = fake.callsTo("POST", "/subscriptions")[0];
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
  assert.equal(fake.callsTo("POST", "/customers").length, 1, "o cliente do Asaas é reaproveitado");
});

// --- recuperação antes de criar --------------------------------------------
//
// POST /subscriptions não é idempotente e o Asaas não oferece Idempotency-Key. Se a resposta
// se perder depois de o Asaas ter criado a assinatura, repetir o checkout criaria a segunda: o
// cliente seria cobrado duas vezes e o cancelamento só conheceria a última, deixando a
// primeira cobrando. A defesa é procurar por externalReference antes de criar.

test("resposta perdida: repetir o checkout adota a assinatura em vez de criar a segunda", async () => {
  const fake = fakeAsaas({ dropFirstSubscriptionResponse: true });
  const asaas = client(fake);
  const { record } = await newKey();

  // 1ª tentativa: o Asaas cria, a resposta se perde, o cliente vê erro.
  await assert.rejects(() => startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer }));
  assert.equal(fake.subscriptions.size, 1, "o Asaas já tem a assinatura");
  assert.equal(await store.get(`billing:key:${record.id}`), null, "e o nosso lado não sabe dela");

  // 2ª tentativa: o cliente repete, como qualquer um faria.
  const result = await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });

  assert.equal(fake.subscriptions.size, 1, "não pode existir uma segunda assinatura cobrando");
  assert.equal(result.subscription_id, "sub_1", "a resposta aponta para a que já existe");
  assert.equal(
    fake.callsTo("POST", "/subscriptions").length,
    1,
    "o POST só aconteceu na 1ª tentativa; a 2ª resolveu pela consulta",
  );
});

test("a assinatura adotada aparece no status e pode ser cancelada", async () => {
  const fake = fakeAsaas({ dropFirstSubscriptionResponse: true });
  const asaas = client(fake);
  const { record } = await newKey();

  await assert.rejects(() => startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer }));
  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });

  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.subscription?.id, "sub_1");
  assert.equal(status.subscription?.status, "active");

  // O essencial: o cliente consegue se livrar da cobrança sozinho.
  await cancelSubscription({ store, asaas }, record);
  assert.equal(fake.subscriptions.get("sub_1")?.deleted, true, "a cobrança precisa cessar no Asaas");
});

test("órfã de outro plano é adotada e devolve 409, para poder ser cancelada", async () => {
  const fake = fakeAsaas({ dropFirstSubscriptionResponse: true });
  const asaas = client(fake);
  const { record } = await newKey();

  await assert.rejects(() => startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer }));

  // Agora o cliente tenta outro plano, sem saber que a anterior ficou criada.
  await assert.rejects(
    () => startCheckout({ store, asaas, now: NOW }, record, { plan: "scale", customer }),
    (err: unknown) => err instanceof BillingError && err.status === 409 && err.code === "subscription_exists",
  );

  assert.equal(fake.subscriptions.size, 1, "a recusa não pode criar nada");
  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.subscription?.id, "sub_1", "mesmo recusando, a órfã tem de ficar visível");
  assert.equal(status.subscription?.plan, "pro", "o plano vem do valor cobrado de verdade");
});

test("órfã com valor fora dos planos atuais vira conflito explícito", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();
  // Assinatura ativa no Asaas por um preço que não é de nenhum plano (ex.: preço antigo).
  fake.subscriptions.set("sub_9", { id: "sub_9", ref: record.id, value: 17, status: "ACTIVE", deleted: false });

  await assert.rejects(
    () => startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer }),
    (err: unknown) =>
      err instanceof BillingError && err.status === 409 && err.code === "subscription_conflict" && /sub_9/.test(err.message),
  );
  assert.equal(fake.callsTo("POST", "/subscriptions").length, 0, "não adivinha o plano nem cria outra");
});

test("se a consulta de assinaturas falha, o checkout falha fechando", async () => {
  const fake = fakeAsaas({ failSubscriptionList: true });
  const asaas = client(fake);
  const { record } = await newKey();

  await assert.rejects(() => startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer }));
  assert.equal(fake.callsTo("POST", "/subscriptions").length, 0, "sem poder consultar, criar arriscaria cobrar duas vezes");
  assert.equal(fake.callsTo("POST", "/customers").length, 0);
});

test("cliente já existente no Asaas é reaproveitado, sem duplicar", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();
  // Cliente criado numa tentativa anterior cuja gravação local não aconteceu.
  fake.customers.set("cus_7", { id: "cus_7", ref: record.id, deleted: false });

  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });

  assert.equal(fake.callsTo("POST", "/customers").length, 0, "não cria um segundo cliente para o mesmo CPF");
  assert.equal(fake.callsTo("POST", "/subscriptions")[0]?.body?.["customer"], "cus_7");
  assert.equal(await store.get(`billing:customer:${record.id}`), "cus_7", "e passa a ficar em cache");
});

test("falha na consulta de clientes não interrompe: cliente duplicado não cobra ninguém", async () => {
  const fake = fakeAsaas({ failCustomerList: true });
  const asaas = client(fake);
  const { record } = await newKey();

  const result = await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  assert.equal(result.subscription_id, "sub_1");
  assert.equal(fake.callsTo("POST", "/customers").length, 1, "segue adiante e cria");
});

test("assinatura removida no Asaas não é adotada: contratar de novo continua possível", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();

  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  await cancelSubscription({ store, asaas }, record);

  const again = await startCheckout({ store, asaas, now: NOW }, record, { plan: "scale", customer });
  assert.equal(again.subscription_id, "sub_2", "a cancelada não pode ser readotada");
  assert.equal(again.plan, "scale");
});

// --- reconciliação ---------------------------------------------------------
//
// O webhook é o único caminho que libera acesso, e ele falha de formas silenciosas: o Asaas
// pausa a fila após 15 falhas seguidas, um deploy ruim perde eventos. O cliente fica sem o
// acesso que pagou. A reconciliação reconstrói o direito a partir das cobranças.

/** Assinatura ativa e paga no Asaas, mas com a chave sem acesso: o evento se perdeu. */
async function lostEventState(fake: ReturnType<typeof fakeAsaas>) {
  const asaas = client(fake);
  const { key, record } = await newKey();
  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  // O Asaas confirmou a cobrança; o nosso lado nunca soube.
  fake.payments.set("sub_1", [
    { id: "pay_1", status: "CONFIRMED", dueDate: "2026-10-15", confirmedDate: "2026-10-15" },
  ]);
  const fresh = (await getKeyRecordById(store, record.id))!;
  assert.equal(effectivePlan(fresh), "free", "a chave começa sem acesso pago");
  return { asaas, key, record: fresh };
}

test("evento perdido: consultar o status reconstrói o acesso pago", async () => {
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);

  const status = await getBillingStatus({ store, asaas }, record);

  assert.equal(status.plan, "pro", "o acesso pago precisa voltar sem depender de evento");
  assert.ok(status.plan_until);
  const after = (await getKeyRecordById(store, record.id))!;
  assert.equal(effectivePlan(after), "pro", "e ficar gravado, não só aparecer na resposta");
});

test("a reconciliação chega ao mesmo planUntil que o webhook teria gravado", async () => {
  // A regra de direito ao acesso é uma só (paidUntil); duas implementações divergiriam.
  const viaReconcile = await (async () => {
    const fake = fakeAsaas();
    const { asaas, record } = await lostEventState(fake);
    await getBillingStatus({ store, asaas }, record);
    return (await getKeyRecordById(store, record.id))!.planUntil;
  })();

  store = createMemoryStore();
  setStore(store);

  const viaWebhook = await (async () => {
    const fake = fakeAsaas();
    const asaas = client(fake);
    const { record } = await newKey();
    await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
    await handleAsaasEvent(
      store,
      paymentEvent("evt_1", "PAYMENT_CONFIRMED", { dueDate: "2026-10-15", dateCreated: "2026-10-15 10:00:00" }),
      NOW,
    );
    return (await getKeyRecordById(store, record.id))!.planUntil;
  })();

  // Não dá para serem idênticos: o evento traz `dateCreated` com hora, a cobrança traz só a
  // data da confirmação. A regra (paidUntil) é uma só; a precisão da entrada é que difere.
  // O invariante que importa é a direção: reconciliar nunca concede MENOS que o webhook, já
  // que o evento se perdeu por falha nossa.
  assert.ok(viaReconcile && viaWebhook);
  assert.ok(
    Date.parse(viaReconcile) >= Date.parse(viaWebhook),
    `reconciliação (${viaReconcile}) não pode ficar antes do webhook (${viaWebhook})`,
  );
  assert.equal(viaReconcile.slice(0, 10), viaWebhook.slice(0, 10), "e cai no mesmo dia");
});

test("reconciliar é idempotente: repetir não muda o resultado", async () => {
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);

  await getBillingStatus({ store, asaas }, record);
  const primeiro = (await getKeyRecordById(store, record.id))!.planUntil;
  const atualizada = (await getKeyRecordById(store, record.id))!;
  await getBillingStatus({ store, asaas }, atualizada);
  assert.equal((await getKeyRecordById(store, record.id))!.planUntil, primeiro);
});

test("só estende: não encurta um período pago já concedido", async () => {
  // Exercita reconcileSubscription direto: pelo GET o gate exige acesso vencido, e um
  // planUntil futuro faria a reconciliação nem rodar — o teste passaria sem testar nada.
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);

  // Já concedido até depois do que a cobrança de 15/10 justifica, mas ainda no passado,
  // para o estado continuar sendo o de "sem acesso pago vigente".
  const concedido = new Date("2026-12-31T00:00:00.000Z").toISOString();
  await updateKeyPlan(store, record.id, { plan: "pro", planUntil: concedido });
  const atual = (await getKeyRecordById(store, record.id))!;

  const result = await reconcileSubscription({ store, asaas, now: NOW }, atual);

  assert.equal(result.plan_until, null, "não há o que estender");
  assert.equal((await getKeyRecordById(store, record.id))!.planUntil, concedido);
});

test("estende quando a cobrança justifica mais do que já havia", async () => {
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);
  const curto = new Date("2026-10-20T00:00:00.000Z").toISOString();
  await updateKeyPlan(store, record.id, { plan: "pro", planUntil: curto });
  const atual = (await getKeyRecordById(store, record.id))!;

  const result = await reconcileSubscription({ store, asaas, now: NOW }, atual);

  assert.ok(result.plan_until);
  assert.ok(Date.parse(result.plan_until) > Date.parse(curto));
});

test("falha ao consultar assinaturas não marca a assinatura como cancelada", async () => {
  // Marcar por causa de uma falha de rede liberaria um segundo checkout — exatamente a
  // cobrança dupla que findActiveSubscription existe para evitar.
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);
  fake.fail.subscriptionList = true;

  const result = await reconcileSubscription({ store, asaas, now: NOW }, record);

  assert.equal(result.subscription_cancelled, false);
  const billing = await store.get<{ status: string }>(`billing:key:${record.id}`);
  assert.equal(billing?.status, "active", "na dúvida, mantém como está");
});

test("cobrança estornada não dá direito a acesso", async () => {
  const fake = fakeAsaas();
  const { asaas, record } = await lostEventState(fake);
  fake.payments.set("sub_1", [{ id: "pay_1", status: "REFUNDED", dueDate: "2026-10-15", confirmedDate: "2026-10-15" }]);

  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.plan, "free");
  assert.equal(status.plan_until, null);
});

test("no caminho saudável não consulta as cobranças à toa", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();
  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  await updateKeyPlan(store, record.id, {
    plan: "pro",
    planUntil: new Date(NOW.getTime() + 20 * 86_400_000).toISOString(),
  });

  const saudavel = (await getKeyRecordById(store, record.id))!;
  const antes = fake.callsTo("GET", "/subscriptions/sub_1/payments").length;
  await getBillingStatus({ store, asaas }, saudavel);
  const depois = fake.callsTo("GET", "/subscriptions/sub_1/payments").length;

  // Uma única chamada, a do link pendente, que já existia antes da reconciliação.
  assert.equal(depois - antes, 1, "acesso pago vigente não precisa de reconciliação");
});

test("assinatura removida no painel do Asaas é marcada como cancelada", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();
  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  // Cancelada direto no Asaas, sem o evento chegar até nós.
  fake.subscriptions.get("sub_1")!.deleted = true;
  fake.subscriptions.get("sub_1")!.status = "INACTIVE";

  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.subscription?.status, "cancelled");

  // E o principal: contratar de novo volta a ser possível.
  const novo = await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });
  assert.equal(novo.subscription_id, "sub_2");
});

test("falha ao reconciliar não derruba a consulta de status", async () => {
  const fake = fakeAsaas({ failPaymentList: true });
  const asaas = client(fake);
  const { record } = await newKey();
  await startCheckout({ store, asaas, now: NOW }, record, { plan: "pro", customer });

  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.plan, "free", "status é leitura: responde com o que sabe");
  assert.equal(status.subscription?.id, "sub_1");
});

test("sem assinatura não há o que reconciliar", async () => {
  const fake = fakeAsaas();
  const asaas = client(fake);
  const { record } = await newKey();

  const status = await getBillingStatus({ store, asaas }, record);
  assert.equal(status.subscription, null);
  assert.equal(fake.calls.length, 0, "nem chega a falar com o Asaas");
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
  const sentCustomer = fake.callsTo("POST", "/customers")[0];
  assert.equal(sentCustomer?.body?.["cpfCnpj"], "52998224725");
  assert.equal(sentCustomer?.headers["access_token"], "chave-teste");
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
