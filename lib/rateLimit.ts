import type { Store } from "./store.js";

/** Duas janelas: a chave sobrevive à virada do minuto e é descartada pelo Redis depois. */
const WINDOW_TTL_SECONDS = 120;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Segundos até a janela virar. */
  retryAfter: number;
}

/**
 * Contador de janela fixa de um minuto, atômico via `incr`.
 *
 * `bucket` identifica o sujeito do limite (chave de API, IP, ...) sem o minuto: o minuto é
 * acrescentado aqui. Janela fixa, não deslizante — dois picos em minutos vizinhos podem somar
 * até 2× o limite na virada. É suficiente para conter abuso e custa um único comando.
 */
export async function rateLimitPerMinute(
  store: Store,
  bucket: string,
  limit: number,
  now = new Date(),
): Promise<RateLimitResult> {
  const key = `${bucket}:${Math.floor(now.getTime() / 60_000)}`;
  const hits = await store.incr(key);
  if (hits === 1) await store.expire(key, WINDOW_TTL_SECONDS);
  return {
    allowed: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    retryAfter: 60 - now.getUTCSeconds(),
  };
}
