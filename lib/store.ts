import { Redis } from "@upstash/redis";

/**
 * Armazenamento mínimo usado pela plataforma.
 * Em produção usa Redis (Upstash). Sem credenciais, cai para memória local
 * (útil em desenvolvimento e testes; NÃO persiste entre invocações na Vercel).
 */
export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx?: boolean; exSeconds?: number }): Promise<boolean>;
  incr(key: string): Promise<number>;
  incrBy(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
}

class MemoryStore implements Store {
  private data = new Map<string, { value: unknown; expiresAt?: number }>();

  private alive(key: string) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string) {
    return (this.alive(key)?.value as T | undefined) ?? null;
  }

  async set(key: string, value: unknown, opts?: { nx?: boolean; exSeconds?: number }) {
    if (opts?.nx && this.alive(key)) return false;
    this.data.set(key, {
      value,
      expiresAt: opts?.exSeconds ? Date.now() + opts.exSeconds * 1000 : undefined,
    });
    return true;
  }

  async incr(key: string) {
    return this.incrBy(key, 1);
  }

  async incrBy(key: string, amount: number) {
    const entry = this.alive(key);
    const next = (typeof entry?.value === "number" ? entry.value : 0) + amount;
    this.data.set(key, { value: next, expiresAt: entry?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number) {
    const entry = this.alive(key);
    if (entry) entry.expiresAt = Date.now() + seconds * 1000;
  }
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}

  async get<T>(key: string) {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set(key: string, value: unknown, opts?: { nx?: boolean; exSeconds?: number }) {
    // SetCommandOptions é uma união discriminada (cada variante marca as outras como `never`),
    // então cada combinação precisa ser um literal próprio: um objeto montado campo a campo
    // não casa com nenhuma variante.
    const v = value as string;
    const ex = opts?.exSeconds;
    const result = await (opts?.nx
      ? ex
        ? this.redis.set(key, v, { nx: true, ex })
        : this.redis.set(key, v, { nx: true })
      : ex
        ? this.redis.set(key, v, { ex })
        : this.redis.set(key, v));
    return result === "OK";
  }

  async incr(key: string) {
    return this.redis.incr(key);
  }

  async incrBy(key: string, amount: number) {
    return this.redis.incrby(key, amount);
  }

  async expire(key: string, seconds: number) {
    await this.redis.expire(key, seconds);
  }
}

let instance: Store | undefined;

export function getStore(): Store {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  instance = url && token ? new RedisStore(new Redis({ url, token })) : new MemoryStore();
  return instance;
}

/** Somente para testes. */
export function setStore(store: Store | undefined) {
  instance = store;
}

export function createMemoryStore(): Store {
  return new MemoryStore();
}

export function usingMemoryStore() {
  return getStore() instanceof MemoryStore;
}
