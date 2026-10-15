import { AsaasError, type AsaasClient } from "./asaas.js";
import { effectivePlan, getKeyRecordById, updateKeyPlan, type KeyRecord } from "./auth.js";
import { apiError } from "./http.js";
import { BILLING_CYCLE_DAYS, GRACE_DAYS, PLANS, type PaidPlanId } from "./plans.js";
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

async function findPaymentUrl(asaas: AsaasClient, subscriptionId: string, status?: string): Promise<string | null> {
  try {
    const list = await asaas.listSubscriptionPayments(subscriptionId, status);
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

  let customerId = await store.get<string>(customerKey(key.id));
  if (!customerId) {
    const customer = await asaas.createCustomer({
      name: input.customer.name,
      cpfCnpj: input.customer.document,
      email: input.customer.email,
      externalReference: key.id,
    });
    if (!customer?.id) throw new BillingError(502, "payment_provider_error", "Resposta inesperada do provedor de pagamento.");
    customerId = customer.id;
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

  await store.set(subscriptionKey(subscription.id), { keyId: key.id, plan: input.plan } satisfies SubscriptionIndex);
  await store.set(keyBillingKey(key.id), {
    subscriptionId: subscription.id,
    plan: input.plan,
    status: "active",
    createdAt: now.toISOString(),
  } satisfies BillingRecord);

  const paymentUrl = (await findPaymentUrl(asaas, subscription.id)) ?? subscription.paymentLink ?? null;
  return { subscription_id: subscription.id, plan: input.plan, price_brl: price, payment_url: paymentUrl };
}

export async function getBillingStatus(deps: { store: Store; asaas: AsaasClient | null }, key: KeyRecord) {
  const { store, asaas } = deps;
  const record = await store.get<BillingRecord>(keyBillingKey(key.id));
  const plan = effectivePlan(key);
  const month = new Date().toISOString().slice(0, 7);
  const used = (await store.get<number>(`usage:${key.id}:${month}`)) ?? 0;

  let pendingPaymentUrl: string | null = null;
  if (record?.status === "active" && asaas) {
    pendingPaymentUrl = await findPaymentUrl(asaas, record.subscriptionId, "PENDING");
  }

  return {
    plan,
    contracted_plan: key.plan,
    plan_until: key.planUntil ?? null,
    subscription: record ? { id: record.subscriptionId, plan: record.plan, status: record.status } : null,
    pending_payment_url: pendingPaymentUrl,
    usage: { month, used, limit: PLANS[plan].monthlyQuota },
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

/** Pix só emite RECEIVED; boleto e cartão emitem CONFIRMED e depois RECEIVED. Qualquer um libera o acesso. */
const GRANT_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);
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

  // Base = o que for mais tarde entre o vencimento e o momento do evento: quem paga adiantado
  // continua o ciclo normal e quem paga muito atrasado ainda recebe o mês inteiro.
  const due = parseDateOnly(asString(event.payment?.dueDate)) ?? 0;
  const eventTime = parseAsaasTimestamp(asString(event.dateCreated)) ?? 0;
  const base = Math.max(due, eventTime) || now.getTime();
  const until = base + (BILLING_CYCLE_DAYS + GRACE_DAYS) * DAY_MS;

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
