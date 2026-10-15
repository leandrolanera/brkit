import { createHash, randomBytes } from "node:crypto";
import type { PlanId } from "./plans.js";
import type { Store } from "./store.js";

export interface KeyRecord {
  /** Identificador público e estável da chave (derivado do hash). */
  id: string;
  plan: PlanId;
  owner: string;
  createdAt: string;
  /**
   * Fim do período pago (ISO). Passada essa data, a chave volta ao plano free.
   * Ausente = plano concedido manualmente, sem vencimento.
   */
  planUntil?: string;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(): string {
  return `ak_live_${randomBytes(24).toString("hex")}`;
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
    id: hash.slice(0, 12),
    plan,
    owner,
    createdAt: new Date().toISOString(),
  };
  await store.set(`key:${hash}`, record);
  await store.set(`keyidx:${record.id}`, hash);
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
