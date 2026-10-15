import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface QrRecord {
  url: string;
  /** id da chave de API dona do código. */
  owner: string;
  createdAt: string;
  updatedAt?: string;
}

/** Aceita apenas http(s) público, sem credenciais embutidas. Devolve a URL normalizada ou null. */
export function validateTargetUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  if (!host.includes(".") && !host.includes(":")) return null;
  return u.toString();
}

export function newCodeId(length = 7): string {
  let id = "";
  for (const byte of randomBytes(length)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

export function isCodeId(id: string): boolean {
  return /^[0-9A-Za-z]{7}$/.test(id);
}

export async function createDynamicCode(store: Store, url: string, owner: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newCodeId();
    const record: QrRecord = { url, owner, createdAt: new Date().toISOString() };
    if (await store.set(`qr:${id}`, record, { nx: true })) return id;
  }
  throw new Error("could_not_allocate_code");
}

export async function getCode(store: Store, id: string): Promise<QrRecord | null> {
  if (!isCodeId(id)) return null;
  return store.get<QrRecord>(`qr:${id}`);
}

export async function updateCodeTarget(store: Store, id: string, record: QrRecord, url: string): Promise<void> {
  await store.set(`qr:${id}`, { ...record, url, updatedAt: new Date().toISOString() } satisfies QrRecord);
}

export async function countScan(store: Store, id: string): Promise<number> {
  return store.incr(`qrscans:${id}`);
}

export async function scanCount(store: Store, id: string): Promise<number> {
  return (await store.get<number>(`qrscans:${id}`)) ?? 0;
}
