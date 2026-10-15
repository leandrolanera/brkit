import { AsaasError, type AsaasClient } from "./asaas.js";
import { effectivePlan, getKeyRecordById, updateKeyPlan, type KeyRecord } from "./auth.js";
import { apiError } from "./http.js";
import { BILLING_CYCLE_DAYS, GRACE_DAYS, PLANS, type PaidPlanId, type PlanId } from "./plans.js";
import type { Store } from "./store.js";

/**
 * Cobrança por assinatura mensal no Asaas.
 *
 * Modelo de acesso: cada pagamento confirmado estende o `planUntil` da chave
 * (vencimento da cobrança + 31 dias + 3 de tolerância). Passada essa data a chave volta ao free
 * sozinha, sem depender de evento de inadimplência nem da ordem em que os webhooks chegam.
 */

const DAY_MS = 86_400_000;
const EVENT_TTL_SECONDS = 7 * 24 * 3600;

export class BillingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export interface BillingRecord {
  subscriptionId: string;
  plan: PaidPlanId;
  status: "active" | "cancelled";
  createdAt: string;
}

interface SubscriptionIndex {
  keyId: string;
  plan: PaidPlanId;
}

const keyBillingKey = (keyId: string) => `billing:key:${keyId}`;
const customerKey = (keyId: string) => `billing:customer:${keyId}`;
const subscriptionKey = (subscriptionId: string) => `billing:sub:${subscriptionId}`;
const eventKey = (eventId: string) => `billing:evt:${eventId}`;

/** Data de hoje em São Paulo (UTC−3, sem horário de verão), no formato AAAA-MM-DD. */
export function todayInBrazil(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

const asString = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function parseDateOnly(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** O Asaas envia dateCreated como "AAAA-MM-DD HH:MM:SS", que tratamos como horário de Brasília. */
function parseAsaasTimestamp(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value.replace(" ", "T")}-03:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** Plano reconhecido pela mensalidade. Usado para adotar uma assinatura que já existe no Asaas. */
function planFromPrice(value: unknown): PaidPlanId | null {
  if (typeof value !== "number") return null;
  for (const plan of ["pro", "scale"] as const) {
    if (PLANS[plan].priceBRL === value) return plan;
  }
  return null;
}

/**
 * Assinatura ativa que já exista no Asaas para esta chave.
 *
 * `POST /subscriptions` não é idempotente e o Asaas não oferece Idempotency-Key. Se a resposta
 * se perder depois de o Asaas ter criado a assinatura, uma nova tentativa criaria a segunda: o
 * cliente passaria a ser cobrado duas vezes e o cancelamento só conheceria a última, deixando a
 * primeira cobrando indefinidamente. Por isso procuramos antes de criar, pelo
 * `externalReference` (o id da chave), que é o caminho de reconciliação indicado pelo Asaas.
 *
 * Um erro aqui sobe de propósito: sem conseguir consultar, criar arriscaria a cobrança dupla.
 * Para dinheiro, falhar fechando é o lado certo de errar.
 */
async function findActiveSubscription(asaas: AsaasClient, keyId: string): Promise<{ id: string; value?: number } | null> {
  const list = await asaas.listSubscriptions(keyId);
  return list.data?.find((s) => s.id && s.deleted !== true && s.status === "ACTIVE") ?? null;
}

/**
 * Cliente que já exista no Asaas para esta chave.
 *
 * Mesmo problema do checkout, consequência bem menor: cliente duplicado não cobra ninguém.
 * Então aqui a falha na consulta não interrompe — segue e cria.
 */
async function findExistingCustomer(asaas: AsaasClient, keyId: string): Promise<string | null> {
  try {
    const list = await asaas.listCustomers(keyId);
    return list.data?.find((c) => c.id && c.deleted !== true)?.id ?? null;
  } catch (err) {
    console.warn("asaas_list_customers_failed", err instanceof AsaasError ? err.status : "unknown");
    return null;
  }
}

/**
 * Grava a assinatura dos dois lados do índice.
 *
 * O índice por assinatura vem primeiro de propósito: se a segunda gravação falhar, o webhook
 * ainda consegue mapear pagamento → chave e liberar o acesso que o cliente pagou. Na ordem
 * inversa, o pagamento chegaria sem efeito, que é o pior dos dois estados incompletos.
 */
async function recordSubscription(
  store: Store,
  keyId: string,
  subscriptionId: string,
  plan: PaidPlanId,
  now: Date,
): Promise<void> {
  await store.set(subscriptionKey(subscriptionId), { keyId, plan } satisfies SubscriptionIndex);
  await store.set(keyBillingKey(keyId), {
    subscriptionId,
    plan,
    status: "active",
    createdAt: now.toISOString(),
  } satisfies BillingRecord);
}

async function findPaymentUrl(asaas: AsaasClient, subscriptionId: string, status?: string): Promise<string | null> {
  try {
    const list = await asaas.listSubscriptionPayments(subscriptionId, { status });
    return list.data?.find((p) => typeof p.invoiceUrl === "string" && p.invoiceUrl)?.invoiceUrl ?? null;
  } catch (err) {
    console.warn("asaas_list_payments_failed", err instanceof AsaasError ? err.status : "unknown");
    return null;
  }
}

export interface CheckoutInput {
  plan: PaidPlanId;
  /** `document` já normalizado (CPF ou CNPJ, sem pontuação). */
  customer: { name: string; document: string; email: string };
}

export interface CheckoutResult {
  subscription_id: string;
  plan: PaidPlanId;
  price_brl: number;
  /** Link da fatura onde o cliente escolhe Pix, boleto ou cartão. Pode vir nulo se o Asaas ainda não gerou a cobrança. */
  payment_url: string | null;
}

export async function startCheckout(
  deps: { store: Store; asaas: AsaasClient; now?: Date; successUrl?: string },
  key: KeyRecord,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const { store, asaas } = deps;
  const now = deps.now ?? new Date();

  const current = await store.get<BillingRecord>(keyBillingKey(key.id));
  if (current?.status === "active") {
    throw new BillingError(
      409,
      "subscription_exists",
      "Já existe uma assinatura ativa para esta chave. Cancele-a antes de contratar outro plano.",
    );
  }

  // Antes de criar qualquer coisa: a tentativa anterior pode ter criado a assinatura sem que
  // a resposta tenha chegado até aqui. Ver findActiveSubscription.
  const existing = await findActiveSubscription(asaas, key.id);
  if (existing) {
    const plan = planFromPrice(existing.value);
    if (!plan) {
      throw new BillingError(
        409,
        "subscription_conflict",
        `Existe uma assinatura ativa (${existing.id}) cujo valor não corresponde a nenhum plano atual. Cancele-a no Asaas antes de contratar.`,
      );
    }
    // Adota antes de qualquer recusa: ela está cobrando de verdade, então precisa aparecer em
    // GET /v1/billing e ser cancelável por DELETE /v1/billing.
    await recordSubscription(store, key.id, existing.id, plan, now);
    if (plan !== input.plan) {
      throw new BillingError(
        409,
        "subscription_exists",
        `Já existe uma assinatura ativa no plano ${plan} para esta chave. Cancele-a antes de contratar outro plano.`,
      );
    }
    return {
      subscription_id: existing.id,
      plan,
      price_brl: PLANS[plan].priceBRL,
      payment_url: await findPaymentUrl(asaas, existing.id),
    };
  }

  let customerId = await store.get<string>(customerKey(key.id));
  if (!customerId) {
    customerId = await findExistingCustomer(asaas, key.id);
    if (!customerId) {
      const customer = await asaas.createCustomer({
        name: input.customer.name,
        cpfCnpj: input.customer.document,
        email: input.customer.email,
        externalReference: key.id,
      });
      if (!customer?.id) {
        throw new BillingError(502, "payment_provider_error", "Resposta inesperada do provedor de pagamento.");
      }
      customerId = customer.id;
    }
    await store.set(customerKey(key.id), customerId);
  }

  const price = PLANS[input.plan].priceBRL;
  const subscription = await asaas.createSubscription({
    customer: customerId,
    billingType: "UNDEFINED",
    value: price,
    nextDueDate: todayInBrazil(now),
    cycle: "MONTHLY",
    description: `API Portfolio - plano ${input.plan}`,
    externalReference: key.id,
    callback: deps.successUrl ? { successUrl: deps.successUrl, autoRedirect: true } : undefined,
  });
  if (!subscription?.id) throw new BillingError(502, "payment_provider_error", "Resposta inesperada do provedor de pagamento.");

  await recordSubscription(store, key.id, subscription.id, input.plan, now);

  const paymentUrl = (await findPaymentUrl(asaas, subscription.id)) ?? subscription.paymentLink ?? null;
  return { subscription_id: subscription.id, plan: input.plan, price_brl: price, payment_url: paymentUrl };
}

// ---------------------------------------------------------------------------
// Reconciliação

/** Uma assinatura mensal leva mais de 8 anos para passar disso; 100 é o teto do Asaas. */
const RECONCILE_PAYMENT_LIMIT = 100;

/**
 * Status de cobrança que dão direito ao acesso, espelhando GRANT_EVENTS.
 *
 * Ficam de fora, além dos óbvios PENDING e OVERDUE: REFUNDED, REFUND_REQUESTED,
 * REFUND_IN_PROGRESS, CHARGEBACK_REQUESTED, CHARGEBACK_DISPUTE,
 * AWAITING_CHARGEBACK_REVERSAL e AWAITING_RISK_ANALYSIS — em todos eles o dinheiro ou não
 * chegou, ou está saindo.
 */
const PAID_STATUSES = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"]);

export interface ReconcileResult {
  /** true quando algo mudou no estado da chave ou da assinatura. */
  changed: boolean;
  /** Novo fim do período pago, quando a reconciliação estendeu o acesso. */
  plan_until: string | null;
  /** true quando a assinatura foi marcada como cancelada por já não existir no Asaas. */
  subscription_cancelled: boolean;
}

const NOTHING_TO_DO: ReconcileResult = { changed: false, plan_until: null, subscription_cancelled: false };

/**
 * Recalcula o acesso a partir das cobranças que o Asaas realmente tem.
 *
 * O webhook é o único caminho que libera acesso, e ele pode falhar de formas que ninguém
 * percebe: o Asaas pausa a fila depois de 15 falhas seguidas, um deploy com erro perde eventos,
 * e o cliente fica sem o acesso que pagou. A reconciliação fecha essa lacuna sem depender de
 * evento nenhum — lê o histórico de cobranças e aplica a mesma regra (`paidUntil`).
 *
 * É idempotente por construção: parte do estado das cobranças, não de eventos, então rodar duas
 * vezes dá o mesmo resultado.
 *
 * **Só estende, nunca encurta.** Encurtar aqui atropelaria uma revogação por estorno já
 * aplicada pelo webhook. A cobrança estornada não entra na conta (o status dela sai de
 * PAID_STATUSES), mas as que foram pagas e mantidas continuam valendo — então um estorno
 * pontual não apaga o período que outras cobranças já cobriram.
 */
export async function reconcileSubscription(
  deps: { store: Store; asaas: AsaasClient; now?: Date },
  key: KeyRecord,
): Promise<ReconcileResult> {
  const { store, asaas } = deps;
  const now = deps.now ?? new Date();

  const record = await store.get<BillingRecord>(keyBillingKey(key.id));
  if (!record) return NOTHING_TO_DO;

  const payments = await asaas.listSubscriptionPayments(record.subscriptionId, {
    limit: RECONCILE_PAYMENT_LIMIT,
  });

  let until = 0;
  for (const payment of payments.data ?? []) {
    if (!PAID_STATUSES.has(String(payment.status))) continue;
    const due = parseDateOnly(asString(payment.dueDate)) ?? 0;
    // O evento do webhook traz `dateCreated` com hora; o objeto da cobrança só tem datas sem
    // hora. Lemos a data como o FIM do dia para que a reconciliação nunca conceda menos acesso
    // do que o evento teria concedido: o evento se perdeu por falha nossa, então a imprecisão
    // corre a favor do cliente.
    const paidDay = parseDateOnly(asString(payment.paymentDate ?? payment.clientPaymentDate));
    const paidAt = paidDay === null ? 0 : paidDay + DAY_MS - 1;
    until = Math.max(until, paidUntil(due, paidAt, now));
  }

  const current = key.plan === record.plan && key.planUntil ? Date.parse(key.planUntil) : 0;
  let planUntil: string | null = null;
  if (until > current) {
    planUntil = new Date(until).toISOString();
    await updateKeyPlan(store, key.id, { plan: record.plan, planUntil });
  }

  // A assinatura pode ter sido removida no painel do Asaas sem que o evento chegasse, o que
  // deixaria o registro preso em "active" e impediria contratar de novo.
  let cancelled = false;
  if (record.status === "active" && !(await subscriptionStillActive(asaas, key.id, record.subscriptionId))) {
    await store.set(keyBillingKey(key.id), { ...record, status: "cancelled" } satisfies BillingRecord);
    cancelled = true;
  }

  return { changed: planUntil !== null || cancelled, plan_until: planUntil, subscription_cancelled: cancelled };
}

/**
 * Se a assinatura continua ativa no Asaas.
 *
 * Diante de erro devolve true (ou seja, não mexe no registro): marcar como cancelada por causa
 * de uma falha de rede liberaria um segundo checkout e levaria à cobrança dupla que o
 * findActiveSubscription existe para evitar.
 */
async function subscriptionStillActive(asaas: AsaasClient, keyId: string, subscriptionId: string): Promise<boolean> {
  try {
    const list = await asaas.listSubscriptions(keyId);
    const found = list.data?.find((s) => s.id === subscriptionId);
    if (!found) return false;
    return found.deleted !== true && found.status === "ACTIVE";
  } catch (err) {
    console.warn("asaas_list_subscriptions_failed", err instanceof AsaasError ? err.status : "unknown");
    return true;
  }
}

export async function getBillingStatus(deps: { store: Store; asaas: AsaasClient | null }, key: KeyRecord) {
  const { store, asaas } = deps;
  let current = key;
  let record = await store.get<BillingRecord>(keyBillingKey(current.id));

  // Assinatura ativa sem acesso pago vigente é exatamente o sintoma de um evento perdido —
  // e também o estado normal de quem ainda não pagou. Consultar o Asaas resolve qual dos dois
  // é o caso, e só aqui: no caminho saudável a reconciliação não custa nada.
  if (asaas && record?.status === "active" && effectivePlan(current) === "free") {
    try {
      const result = await reconcileSubscription({ store, asaas }, current);
      if (result.changed) {
        console.info("billing_reconciled", current.id, result);
        current = (await getKeyRecordById(store, current.id)) ?? current;
        record = await store.get<BillingRecord>(keyBillingKey(current.id));
      }
    } catch (err) {
      // Status é leitura: uma falha ao reconciliar não pode derrubar a resposta.
      console.warn("billing_reconcile_failed", current.id, err instanceof AsaasError ? err.status : "unknown");
    }
  }

  const plan = effectivePlan(current);
  const month = new Date().toISOString().slice(0, 7);
  const used = (await store.get<number>(`usage:${current.id}:${month}`)) ?? 0;

  let pendingPaymentUrl: string | null = null;
  if (record?.status === "active" && asaas) {
    pendingPaymentUrl = await findPaymentUrl(asaas, record.subscriptionId, "PENDING");
  }

  return {
    plan,
    contracted_plan: current.plan,
    plan_until: current.planUntil ?? null,
    subscription: record ? { id: record.subscriptionId, plan: record.plan, status: record.status } : null,
    pending_payment_url: pendingPaymentUrl,
    usage: { month, used, limit: PLANS[plan].monthlyQuota },
  };
}

export interface ChangePlanResult {
  /** false quando a chave já estava no plano pedido. */
  changed: boolean;
  /** Plano contratado depois da mudança. */
  plan: PaidPlanId;
  /** Plano em vigor neste momento. Difere de `plan` no downgrade. */
  effective_plan: PlanId;
  price_brl: number;
  /**
   * Quando o plano novo passou a valer. `null` significa "no próximo pagamento confirmado":
   * é o caso do downgrade e do upgrade de quem ainda não tem período pago.
   */
  effective_from: string | null;
}

/**
 * Troca o plano de uma assinatura ativa, sem cancelar e contratar de novo.
 *
 * O Asaas não faz cobrança proporcional, então não há como acertar a diferença no meio do
 * ciclo. A política escolhida, que dispensa proporcional e sempre favorece o cliente:
 *
 * - **Upgrade vale na hora.** Quem sobe de plano normalmente acabou de bater na cota; esperar o
 *   ciclo virar anularia o motivo da troca. O custo é a diferença de cota pelo resto do período
 *   já pago, barata nestes endpoints. Se ainda não há período pago, não há o que antecipar: vale
 *   quando o pagamento for confirmado.
 * - **Downgrade vale no próximo pagamento.** O período em curso foi pago no plano maior e o
 *   Asaas não devolve a diferença, então tirar o acesso agora seria retomar algo já pago.
 *
 * O valor novo é aplicado também às cobranças já geradas e não pagas
 * (`updatePendingPayments`): quem trocou antes de pagar paga o preço novo deste ciclo.
 */
export async function changePlan(
  deps: { store: Store; asaas: AsaasClient; now?: Date },
  key: KeyRecord,
  plan: PaidPlanId,
): Promise<ChangePlanResult> {
  const { store, asaas } = deps;
  const now = deps.now ?? new Date();

  const record = await store.get<BillingRecord>(keyBillingKey(key.id));
  if (!record || record.status !== "active") {
    throw new BillingError(
      404,
      "no_active_subscription",
      "Não há assinatura ativa para esta chave. Use POST /v1/billing/checkout para contratar.",
    );
  }

  const price = PLANS[plan].priceBRL;

  // Responde com sucesso em vez de erro: uma repetição por timeout não deve parecer falha
  // quando o estado já é o pedido.
  if (plan === record.plan) {
    return {
      changed: false,
      plan,
      effective_plan: effectivePlan(key, now.getTime()),
      price_brl: price,
      effective_from: null,
    };
  }

  const upgrade = price > PLANS[record.plan].priceBRL;

  await asaas.updateSubscription(record.subscriptionId, {
    value: price,
    description: `API Portfolio - plano ${plan}`,
    updatePendingPayments: true,
  });

  // O índice é o que grantAccess consulta, então mudá-lo faz o próximo pagamento confirmado
  // aplicar o plano novo — sem precisar de mecanismo de "plano pendente".
  await recordSubscription(store, key.id, record.subscriptionId, plan, now);

  // Só antecipa quando já existe período pago para estender. Sem isso, um upgrade feito antes
  // do primeiro pagamento gravaria o plano sem vencimento, ou seja, de graça para sempre.
  const anticipate = upgrade && effectivePlan(key, now.getTime()) !== "free" && Boolean(key.planUntil);
  if (anticipate) await updateKeyPlan(store, key.id, { plan, planUntil: key.planUntil });

  const updated = (await getKeyRecordById(store, key.id)) ?? key;
  return {
    changed: true,
    plan,
    effective_plan: effectivePlan(updated, now.getTime()),
    price_brl: price,
    effective_from: anticipate ? now.toISOString() : null,
  };
}

export async function cancelSubscription(deps: { store: Store; asaas: AsaasClient }, key: KeyRecord) {
  const { store, asaas } = deps;
  const record = await store.get<BillingRecord>(keyBillingKey(key.id));
  if (!record || record.status !== "active") {
    throw new BillingError(404, "no_active_subscription", "Não há assinatura ativa para esta chave.");
  }
  try {
    await asaas.deleteSubscription(record.subscriptionId);
  } catch (err) {
    // 404 = já removida no Asaas; segue para marcar como cancelada aqui também.
    if (!(err instanceof AsaasError && err.status === 404)) throw err;
  }
  await store.set(keyBillingKey(key.id), { ...record, status: "cancelled" } satisfies BillingRecord);
  return { status: "cancelled" as const, access_until: key.planUntil ?? null };
}

/** Converte erros de cobrança em respostas HTTP; qualquer outro erro sobe e vira 500 em withApi. */
export function billingErrorResponse(err: unknown): Response {
  if (err instanceof BillingError) return apiError(err.status, err.code, err.message);
  if (err instanceof AsaasError) {
    console.error("asaas_error", err.status, err.details);
    if (err.status === 400) {
      const reasons = err.details.map((d) => d.description).filter(Boolean).join("; ");
      return apiError(422, "payment_provider_rejected", reasons || "Dados rejeitados pelo provedor de pagamento.");
    }
    return apiError(502, "payment_provider_error", "Falha ao falar com o provedor de pagamento. Tente novamente.");
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Webhook

export interface AsaasEvent {
  id?: unknown;
  event?: unknown;
  dateCreated?: unknown;
  payment?: { id?: unknown; subscription?: unknown; dueDate?: unknown } | null;
  subscription?: { id?: unknown } | null;
}

export type EventOutcome = "processed" | "ignored" | "duplicate";

/**
 * Fim do período pago por uma cobrança: ciclo + tolerância sobre o que for mais tarde entre o
 * vencimento e o momento em que o pagamento se confirmou. Quem paga adiantado continua o ciclo
 * normal; quem paga muito atrasado ainda recebe o mês inteiro.
 *
 * Única definição da regra de direito ao acesso, usada pelo webhook e pela reconciliação. Duas
 * implementações disso divergiriam com o tempo, e a divergência apareceria como cliente sem o
 * acesso que pagou.
 *
 * Os dois argumentos são milissegundos, e 0 significa "não informado": sem nenhum dos dois, a
 * base é o agora.
 */
export function paidUntil(dueDateMs: number, confirmedAtMs: number, now: Date): number {
  const base = Math.max(dueDateMs, confirmedAtMs) || now.getTime();
  return base + (BILLING_CYCLE_DAYS + GRACE_DAYS) * DAY_MS;
}

/**
 * Eventos que significam dinheiro recebido, e por isso liberam o acesso.
 *
 * Pix só emite RECEIVED; boleto e cartão emitem CONFIRMED e depois RECEIVED. DUNNING_RECEIVED
 * é a cobrança recuperada por negativação — chega depois do vencimento, mas é pagamento igual,
 * e ignorá-lo deixaria sem acesso quem acabou de quitar a dívida.
 */
const GRANT_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_DUNNING_RECEIVED"]);
const REVOKE_EVENTS = new Set(["PAYMENT_REFUNDED", "PAYMENT_CHARGEBACK_REQUESTED"]);
const CANCEL_EVENTS = new Set(["SUBSCRIPTION_DELETED", "SUBSCRIPTION_INACTIVATED"]);

/**
 * Processa um evento do Asaas. A entrega é "pelo menos uma vez" e sem garantia de ordem,
 * então tudo aqui é idempotente e a duplicata é descartada pelo id do evento.
 */
export async function handleAsaasEvent(store: Store, event: AsaasEvent, now = new Date()): Promise<EventOutcome> {
  const id = asString(event.id);
  const name = asString(event.event);
  if (!id || !name) return "ignored";
  if (await store.get(eventKey(id))) return "duplicate";

  let outcome: EventOutcome = "ignored";
  if (GRANT_EVENTS.has(name)) outcome = await grantAccess(store, event, now);
  else if (REVOKE_EVENTS.has(name)) outcome = await revokeAccess(store, event, now);
  else if (CANCEL_EVENTS.has(name)) outcome = await markCancelled(store, event);

  await store.set(eventKey(id), 1, { exSeconds: EVENT_TTL_SECONDS });
  return outcome;
}

async function indexFromPayment(store: Store, event: AsaasEvent): Promise<SubscriptionIndex | null> {
  const subscriptionId = asString(event.payment?.subscription);
  if (!subscriptionId) return null; // cobrança avulsa, não ligada a uma assinatura nossa
  return store.get<SubscriptionIndex>(subscriptionKey(subscriptionId));
}

async function grantAccess(store: Store, event: AsaasEvent, now: Date): Promise<EventOutcome> {
  const index = await indexFromPayment(store, event);
  if (!index) return "ignored";
  const key = await getKeyRecordById(store, index.keyId);
  if (!key) return "ignored";

  const due = parseDateOnly(asString(event.payment?.dueDate)) ?? 0;
  const eventTime = parseAsaasTimestamp(asString(event.dateCreated)) ?? 0;
  const until = paidUntil(due, eventTime, now);

  const previous = key.plan === index.plan && key.planUntil ? Date.parse(key.planUntil) : 0;
  await updateKeyPlan(store, index.keyId, {
    plan: index.plan,
    planUntil: new Date(Math.max(until, previous)).toISOString(),
  });
  return "processed";
}

async function revokeAccess(store: Store, event: AsaasEvent, now: Date): Promise<EventOutcome> {
  const index = await indexFromPayment(store, event);
  if (!index) return "ignored";
  const key = await getKeyRecordById(store, index.keyId);
  if (!key) return "ignored";
  await updateKeyPlan(store, index.keyId, { plan: key.plan, planUntil: now.toISOString() });
  return "processed";
}

async function markCancelled(store: Store, event: AsaasEvent): Promise<EventOutcome> {
  const subscriptionId = asString(event.subscription?.id);
  if (!subscriptionId) return "ignored";
  const index = await store.get<SubscriptionIndex>(subscriptionKey(subscriptionId));
  if (!index) return "ignored";
  const record = await store.get<BillingRecord>(keyBillingKey(index.keyId));
  // O acesso pago continua até planUntil. Marcar como cancelada libera um novo checkout.
  if (record && record.subscriptionId === subscriptionId && record.status === "active") {
    await store.set(keyBillingKey(index.keyId), { ...record, status: "cancelled" } satisfies BillingRecord);
  }
  return "processed";
}
