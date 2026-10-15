import assert from "node:assert/strict";
import type { Redis } from "@upstash/redis";
import { describe, test } from "node:test";
import { createMemoryStore, RedisStore, type Store } from "../lib/store.js";

/**
 * O caminho Redis é o único que roda em produção e era o único sem cobertura.
 * Aqui ele é exercitado contra um duplo que imita as semânticas que a plataforma depende
 * (NX, EX, INCR), para que o contrato valha igual nos dois stores.
 */

interface SetCall {
  key: string;
  value: unknown;
  /** `undefined` quando o terceiro argumento não foi passado. */
  opts: unknown;
}

/**
 * Duplo do cliente Upstash com as semânticas reais do Redis para os comandos usados:
 * NX só grava se a chave não existir, EX define TTL, INCR preserva o TTL em vigor.
 *
 * O `get` do Upstash desserializa JSON sozinho, então guardamos o valor como veio:
 * é o round-trip que o cliente real entrega.
 */
class FakeRedis {
  private data = new Map<string, { value: unknown; expiresAt?: number }>();
  readonly setCalls: SetCall[] = [];
  readonly calls: string[] = [];

  /** Relógio controlado pelo teste, para checar TTL sem esperar de verdade. */
  now = 1_000_000;

  private alive(key: string) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  /** TTL restante em segundos, ou null se a chave não tem TTL (ou não existe). */
  ttl(key: string): number | null {
    const entry = this.alive(key);
    if (!entry || entry.expiresAt === undefined) return null;
    return Math.round((entry.expiresAt - this.now) / 1000);
  }

  async get<T>(key: string): Promise<T | null> {
    this.calls.push(`get ${key}`);
    return (this.alive(key)?.value as T | undefined) ?? null;
  }

  async set(key: string, value: unknown, opts?: { nx?: true; ex?: number }) {
    this.calls.push("set");
    this.setCalls.push({ key, value, opts });
    if (opts?.nx && this.alive(key)) return null;
    this.data.set(key, {
      value,
      expiresAt: opts?.ex === undefined ? undefined : this.now + opts.ex * 1000,
    });
    return "OK";
  }

  async incr(key: string) {
    this.calls.push(`incr ${key}`);
    return this.incrby(key, 1);
  }

  async incrby(key: string, amount: number) {
    this.calls.push(`incrby ${key}`);
    const entry = this.alive(key);
    const next = (typeof entry?.value === "number" ? entry.value : 0) + amount;
    this.data.set(key, { value: next, expiresAt: entry?.expiresAt });
    return next;
  }

  async expire(key: string, seconds: number) {
    this.calls.push(`expire ${key}`);
    const entry = this.alive(key);
    if (!entry) return 0;
    entry.expiresAt = this.now + seconds * 1000;
    return 1;
  }
}

function redisStoreWithFake(): { store: Store; fake: FakeRedis } {
  const fake = new FakeRedis();
  // O construtor exige o `Redis` real de propósito (mantém os tipos do pacote verificados
  // em lib/store.ts); aqui o duplo entra por um cast único.
  return { store: new RedisStore(fake as unknown as Redis), fake };
}

// ---------------------------------------------------------------------------
// Contrato comum: o que os dois stores precisam cumprir igual.

const implementations: [string, () => Store][] = [
  ["MemoryStore", () => createMemoryStore()],
  ["RedisStore", () => redisStoreWithFake().store],
];

for (const [name, make] of implementations) {
  describe(`contrato do Store: ${name}`, () => {
    test("get de chave ausente devolve null", async () => {
      assert.equal(await make().get("nao-existe"), null);
    });

    test("set e get fazem round-trip de objeto", async () => {
      const store = make();
      assert.equal(await store.set("k", { plan: "pro", n: 2 }), true);
      assert.deepEqual(await store.get("k"), { plan: "pro", n: 2 });
    });

    test("set sem nx sobrescreve o valor", async () => {
      const store = make();
      await store.set("k", "antes");
      assert.equal(await store.set("k", "depois"), true);
      assert.equal(await store.get("k"), "depois");
    });

    test("set com nx não sobrescreve e devolve false", async () => {
      const store = make();
      assert.equal(await store.set("k", "primeiro", { nx: true }), true);
      assert.equal(await store.set("k", "segundo", { nx: true }), false);
      assert.equal(await store.get("k"), "primeiro");
    });

    test("incr parte de zero e acumula", async () => {
      const store = make();
      assert.equal(await store.incr("c"), 1);
      assert.equal(await store.incr("c"), 2);
      assert.equal(await store.get("c"), 2);
    });

    test("incrBy soma a quantidade pedida", async () => {
      const store = make();
      assert.equal(await store.incrBy("c", 5), 5);
      assert.equal(await store.incrBy("c", 3), 8);
    });
  });
}

// ---------------------------------------------------------------------------
// Mapeamento das opções para o cliente Upstash.
//
// Regressão coberta: SetCommandOptions é uma união discriminada (cada variante marca as
// outras como `never`), então montar o objeto campo a campo não casa com nenhuma variante.
// Estes testes fixam o que chega ao cliente em cada combinação.

describe("RedisStore: opções do SET", () => {
  test("sem opções, não passa o terceiro argumento", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v");
    assert.deepEqual(fake.setCalls[0]?.opts, undefined);
  });

  test("nx vira { nx: true }", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { nx: true });
    assert.deepEqual(fake.setCalls[0]?.opts, { nx: true });
  });

  test("exSeconds vira { ex: n }", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { exSeconds: 120 });
    assert.deepEqual(fake.setCalls[0]?.opts, { ex: 120 });
    assert.equal(fake.ttl("k"), 120);
  });

  test("nx e exSeconds juntos viram { nx: true, ex: n }", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { nx: true, exSeconds: 60 });
    assert.deepEqual(fake.setCalls[0]?.opts, { nx: true, ex: 60 });
    assert.equal(fake.ttl("k"), 60);
  });

  test("nx: false não manda nx para o cliente", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { nx: false, exSeconds: 30 });
    assert.deepEqual(fake.setCalls[0]?.opts, { ex: 30 });
  });

  test("exSeconds: 0 é omitido — o Redis rejeita EX 0", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { exSeconds: 0 });
    assert.deepEqual(fake.setCalls[0]?.opts, undefined);
    assert.equal(fake.ttl("k"), null);
  });

  test("set devolve true só quando o cliente responde OK", async () => {
    const { store } = redisStoreWithFake();
    assert.equal(await store.set("k", "v", { nx: true }), true);
    // Segunda chamada com NX colide: o cliente devolve null, não "OK".
    assert.equal(await store.set("k", "v", { nx: true }), false);
  });
});

// ---------------------------------------------------------------------------
// Delegação: nomes de comando errados passariam calados sem isto.

describe("RedisStore: delegação dos comandos", () => {
  test("incrBy usa o comando incrby do cliente", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.incrBy("c", 4);
    assert.ok(fake.calls.includes("incrby c"));
  });

  test("expire repassa a chave e os segundos", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v");
    await store.expire("k", 90);
    assert.ok(fake.calls.includes("expire k"));
    assert.equal(fake.ttl("k"), 90);
  });

  test("get devolve null quando a chave expirou", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.set("k", "v", { exSeconds: 10 });
    fake.now += 11_000;
    assert.equal(await store.get("k"), null);
  });

  test("incr preserva o TTL em vigor, como o Redis", async () => {
    const { store, fake } = redisStoreWithFake();
    await store.incr("c");
    await store.expire("c", 62);
    await store.incr("c");
    assert.equal(fake.ttl("c"), 62);
  });
});
