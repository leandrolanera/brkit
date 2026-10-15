import { createHash, randomBytes } from "node:crypto";
import type { PlanId } from "./plans.js";
import type { Store } from "./store.js";

export interface KeyRecord {
  /**
   * Identificador público e estável, sorteado na criação e **preservado na rotação**.
   *
   * Não pode ser derivado do hash do segredo: o id é a âncora da cota mensal, do limite por
   * minuto, do registro de cobrança, do dono dos QR Codes e do `externalReference` da
   * assinatura no Asaas. Se mudasse junto com o segredo, rotacionar zeraria a cota, órfãozaria
   * a cobrança, tornaria os QR Codes inacessíveis e faria um novo checkout criar uma segunda
   * assinatura — a cobrança em dobro que `findActiveSubscription` existe para evitar.
   *
   * Chaves criadas antes desta mudança têm id derivado do hash. Continuam válidas: nada
   * recalcula o id a partir do segredo, ele é lido do registro gravado.
   */
  id: string;
  plan: PlanId;
  owner: string;
  createdAt: string;
  /**
   * Fim do período pago (ISO). Passada essa data, a chave volta ao plano free.
   * Ausente = plano concedido manualmente, sem vencimento.
   */
  planUntil?: string;
  /** Última rotação do segredo (ISO). Ausente = nunca rotacionada. */
  rotatedAt?: string;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(): string {
  return `ak_live_${randomBytes(24).toString("hex")}`;
}

/** Id público da chave. Mesmo formato de antes (12 hex), mas independente do segredo. */
export function generateKeyId(): string {
  return randomBytes(6).toString("hex");
}

/** Cria e grava uma chave. A chave em texto puro só existe neste retorno: guarde-a agora. */
export async function createApiKey(
  store: Store,
  owner: string,
  plan: PlanId,
): Promise<{ key: string; record: KeyRecord }> {
  const key = generateKey();
  const hash = hashKey(key);
  const record: KeyRecord = {
    id: generateKeyId(),
    plan,
    owner,
    createdAt: new Date().toISOString(),
  };
  await store.set(`key:${hash}`, record);
  await store.set(`keyidx:${record.id}`, hash);
  return { key, record };
}

/**
 * Troca o segredo de uma chave, preservando o id — e com ele a cota do mês, o plano pago, os
 * QR Codes e o vínculo com a assinatura no Asaas. O segredo anterior deixa de autenticar.
 *
 * Devolve null se o id não existir.
 *
 * A ordem importa: grava o novo, aponta o índice e só então apaga o antigo. Apagar primeiro
 * deixaria, numa falha no meio, o `keyidx` apontando para um hash já removido — a chave ficaria
 * inalcançável até pelo id, e nem a recuperação por e-mail conseguiria consertar. Em troca, uma
 * falha pode deixar o segredo antigo valendo; repetir a rotação resolve.
 */
export async function rotateApiKey(
  store: Store,
  id: string,
  now = new Date(),
): Promise<{ key: string; record: KeyRecord } | null> {
  const found = await getKeyById(store, id);
  if (!found) return null;

  const key = generateKey();
  const hash = hashKey(key);
  const record: KeyRecord = { ...found.record, rotatedAt: now.toISOString() };

  await store.set(`key:${hash}`, record);
  await store.set(`keyidx:${id}`, hash);
  if (found.hash !== hash) await store.del(`key:${found.hash}`);

  return { key, record };
}

export function extractKey(req: Request): string | null {
  const direct = req.headers.get("x-api-key");
  if (direct) return direct.trim();
  const auth = req.headers.get("authorization");
  const match = auth?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

export async function lookupKey(store: Store, key: string): Promise<KeyRecord | null> {
  return store.get<KeyRecord>(`key:${hashKey(key)}`);
}

/** Plano em vigor agora: plano pago vencido vale como free. */
export function effectivePlan(record: KeyRecord, now = Date.now()): PlanId {
  if (record.plan === "free") return "free";
  if (record.planUntil && Date.parse(record.planUntil) <= now) return "free";
  return record.plan;
}

async function getKeyById(store: Store, id: string): Promise<{ hash: string; record: KeyRecord } | null> {
  const hash = await store.get<string>(`keyidx:${id}`);
  if (!hash) return null;
  const record = await store.get<KeyRecord>(`key:${hash}`);
  return record ? { hash, record } : null;
}

/** Altera plano e vencimento de uma chave pelo id público. Retorna null se a chave não existir. */
export async function updateKeyPlan(
  store: Store,
  id: string,
  patch: { plan: PlanId; planUntil?: string },
): Promise<KeyRecord | null> {
  const found = await getKeyById(store, id);
  if (!found) return null;
  const next: KeyRecord = { ...found.record, plan: patch.plan };
  if (patch.planUntil) next.planUntil = patch.planUntil;
  else delete next.planUntil;
  await store.set(`key:${found.hash}`, next);
  return next;
}

export async function getKeyRecordById(store: Store, id: string): Promise<KeyRecord | null> {
  return (await getKeyById(store, id))?.record ?? null;
}
