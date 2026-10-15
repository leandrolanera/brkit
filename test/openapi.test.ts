import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, test } from "node:test";
import { buildOpenApiDocument } from "../lib/openapi.js";
import { LIMITS as PIX_LIMITS } from "../lib/pix.js";
import { PLANS } from "../lib/plans.js";
import { GET as openapiEndpoint } from "../api/v1/openapi.js";
import { withEnv } from "./helpers.js";

let restoreEnv: () => void = () => {};
afterEach(() => {
  restoreEnv();
  restoreEnv = () => {};
});

const doc = buildOpenApiDocument("https://api.exemplo.com.br");
const paths = doc["paths"] as Record<string, Record<string, unknown>>;
const components = doc["components"] as Record<string, Record<string, unknown>>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Rotas que existem mas de propósito não entram na especificação pública.
 * Deixar isso explícito mantém o teste de cobertura valendo: um endpoint novo esquecido
 * continua quebrando a suíte, em vez de passar calado.
 */
const NOT_PUBLIC: Record<string, string> = {
  "/api/webhooks/asaas": "chamada pelo Asaas, não por clientes: documentar seria ruído",
};

/** Converte o caminho do arquivo em caminho de URL, como fazem as reescritas da Vercel. */
function urlPathFor(file: string): string {
  if (file === "api/redirect.ts") return "/r/{id}"; // reescrito em vercel.json
  const withoutExt = file.replace(/\.ts$/, "");
  const withoutIndex = withoutExt.replace(/\/index$/, "");
  return `/${withoutIndex.replace(/^api\//, "")}`.replace(/^\/v1/, "/v1");
}

function listHandlerFiles(dir = "api"): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listHandlerFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** Rotas de verdade: arquivo + métodos HTTP que ele exporta. */
async function actualRoutes(): Promise<Map<string, Set<string>>> {
  const routes = new Map<string, Set<string>>();
  for (const file of listHandlerFiles()) {
    const specifier = `../${relative(".", file).replace(/\.ts$/, ".js")}`;
    const mod = (await import(specifier)) as Record<string, unknown>;
    const methods = new Set(
      HTTP_METHODS.filter((m) => typeof mod[m.toUpperCase()] === "function").map((m) => m),
    );
    if (methods.size === 0) continue;
    const url = file === "api/webhooks/asaas.ts" ? "/api/webhooks/asaas" : urlPathFor(file);
    routes.set(url, methods);
  }
  return routes;
}

describe("cobertura de rotas", () => {
  test("toda rota exportada está na especificação", async () => {
    const faltando: string[] = [];
    for (const [url, methods] of await actualRoutes()) {
      if (url in NOT_PUBLIC) continue;
      const documented = paths[url];
      if (!documented) {
        faltando.push(`${url} (nenhum método documentado)`);
        continue;
      }
      for (const method of methods) {
        if (!documented[method]) faltando.push(`${method.toUpperCase()} ${url}`);
      }
    }
    assert.deepEqual(faltando, [], "endpoint sem documentação: adicione em lib/openapi.ts");
  });

  test("nenhum caminho documentado deixou de existir", async () => {
    const real = await actualRoutes();
    const sobrando: string[] = [];
    for (const [url, operations] of Object.entries(paths)) {
      const methods = real.get(url);
      if (!methods) {
        sobrando.push(`${url} (rota inexistente)`);
        continue;
      }
      for (const method of Object.keys(operations)) {
        if (HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number]) && !methods.has(method as never)) {
          sobrando.push(`${method.toUpperCase()} ${url}`);
        }
      }
    }
    assert.deepEqual(sobrando, [], "documentação de rota que não existe mais: remova de lib/openapi.ts");
  });

  test("as exclusões deliberadas continuam existindo como rota", async () => {
    // Se uma exclusão virar rota morta, o motivo registrado em NOT_PUBLIC fica obsoleto.
    const real = await actualRoutes();
    for (const url of Object.keys(NOT_PUBLIC)) {
      assert.ok(real.has(url), `${url} está na lista de exclusões mas não existe mais`);
    }
  });
});

describe("limites documentados saem das constantes do código", () => {
  test("a tabela de planos reflete lib/plans.ts", () => {
    const description = String((doc["info"] as Record<string, unknown>)["description"]);
    for (const [id, plan] of Object.entries(PLANS)) {
      assert.ok(description.includes(`\`${id}\``), `plano ${id} ausente da descrição`);
      assert.ok(
        description.includes(plan.monthlyQuota.toLocaleString("pt-BR")),
        `cota de ${id} (${plan.monthlyQuota}) não aparece: a documentação divergiu do código`,
      );
      assert.ok(description.includes(String(plan.perMinute)), `limite por minuto de ${id} não aparece`);
    }
  });

  test("os planos nos schemas são exatamente os de lib/plans.ts", () => {
    const schemas = components["schemas"] as Record<string, Record<string, unknown>>;
    const issued = schemas["IssuedKey"] as { properties: Record<string, { enum?: string[] }> };
    assert.deepEqual(issued.properties["plan"]?.enum, Object.keys(PLANS));
  });

  test("os limites de campo do Pix saem de lib/pix.ts", () => {
    const body = paths["/v1/pix/qr"]?.["post"] as {
      requestBody: { content: Record<string, { schema: { properties: Record<string, { maxLength?: number }> } }> };
    };
    const props = body.requestBody.content["application/json"]!.schema.properties;
    assert.equal(props["name"]?.maxLength, PIX_LIMITS.name);
    assert.equal(props["city"]?.maxLength, PIX_LIMITS.city);
    assert.equal(props["txid"]?.maxLength, PIX_LIMITS.txid);
  });
});

describe("integridade do documento", () => {
  /** Coleta todo `$ref` do documento, em qualquer profundidade. */
  function collectRefs(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item, found);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") found.push(v);
        else collectRefs(v, found);
      }
    }
    return found;
  }

  function resolve(ref: string): unknown {
    assert.ok(ref.startsWith("#/"), `referência externa não suportada: ${ref}`);
    let node: unknown = doc;
    for (const part of ref.slice(2).split("/")) {
      assert.ok(node && typeof node === "object", `caminho interrompido em ${ref}`);
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  test("todo $ref resolve", () => {
    const refs = collectRefs(doc);
    assert.ok(refs.length > 10, "deveria haver referências de sobra para valer a checagem");
    for (const ref of new Set(refs)) {
      assert.ok(resolve(ref) !== undefined, `$ref quebrado: ${ref}`);
    }
  });

  test("todo schema declarado é usado em algum lugar", () => {
    const schemas = Object.keys(components["schemas"] as Record<string, unknown>);
    const usados = new Set(collectRefs(doc).map((r) => r.replace("#/components/schemas/", "")));
    const orfaos = schemas.filter((name) => !usados.has(name));
    assert.deepEqual(orfaos, [], "schema declarado e nunca referenciado");
  });

  test("toda operação tem operationId, summary e respostas", () => {
    for (const [url, operations] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
        const operation = op as Record<string, unknown>;
        assert.ok(operation["operationId"], `${method.toUpperCase()} ${url} sem operationId`);
        assert.ok(operation["summary"], `${method.toUpperCase()} ${url} sem summary`);
        const responses = operation["responses"] as Record<string, unknown> | undefined;
        assert.ok(responses && Object.keys(responses).length > 0, `${method.toUpperCase()} ${url} sem respostas`);
        assert.ok(
          Object.keys(responses).some((code) => code.startsWith("2") || code.startsWith("3")),
          `${method.toUpperCase()} ${url} sem resposta de sucesso`,
        );
      }
    }
  });

  test("operationId é único", () => {
    const ids: string[] = [];
    for (const operations of Object.values(paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
        ids.push(String((op as Record<string, unknown>)["operationId"]));
      }
    }
    assert.equal(new Set(ids).size, ids.length, `operationId repetido em: ${ids.join(", ")}`);
  });

  test("as rotas públicas dispensam autenticação explicitamente", () => {
    // Sem `security: []`, o `security` global do documento valeria e a doc pediria chave
    // para quem está justamente tentando obter uma.
    const publicas = ["/v1/signup", "/v1/signup/verify", "/v1/keys/recover", "/v1/keys/recover/verify", "/v1/health", "/v1/openapi", "/r/{id}"];
    for (const url of publicas) {
      const op = paths[url]?.["get"] ?? paths[url]?.["post"];
      assert.deepEqual((op as Record<string, unknown>)["security"], [], `${url} deveria ser pública`);
    }
  });

  test("as rotas autenticadas não sobrescrevem o security global", () => {
    const autenticadas = ["/v1/qr", "/v1/pix/qr", "/v1/boleto/decode", "/v1/billing", "/v1/keys/rotate"];
    for (const url of autenticadas) {
      for (const [method, op] of Object.entries(paths[url] ?? {})) {
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
        assert.equal((op as Record<string, unknown>)["security"], undefined, `${method} ${url} não deveria dispensar chave`);
      }
    }
  });

  test("todo endpoint que consome cota documenta o 402", () => {
    // Quem não consome cota (cobrança, rotação) não deve prometer 402.
    const semCota = new Set(["/v1/billing", "/v1/billing/checkout", "/v1/keys/rotate"]);
    for (const [url, operations] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
        const operation = op as Record<string, unknown>;
        if (operation["security"] !== undefined) continue; // pública
        const responses = operation["responses"] as Record<string, unknown>;
        if (semCota.has(url)) {
          assert.ok(!responses["402"], `${method.toUpperCase()} ${url} não consome cota, não deveria documentar 402`);
        } else {
          assert.ok(responses["402"], `${method.toUpperCase()} ${url} consome cota e deveria documentar 402`);
        }
      }
    }
  });

  test("os dois esquemas de autenticação do projeto estão declarados", () => {
    const schemes = components["securitySchemes"] as Record<string, Record<string, unknown>>;
    assert.equal(schemes["apiKeyHeader"]?.["name"], "x-api-key");
    assert.equal(schemes["bearerAuth"]?.["scheme"], "bearer");
    assert.deepEqual(doc["security"], [{ apiKeyHeader: [] }, { bearerAuth: [] }]);
  });

  test("toda tag usada está declarada", () => {
    const declaradas = new Set((doc["tags"] as { name: string }[]).map((t) => t.name));
    for (const [url, operations] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method as (typeof HTTP_METHODS)[number])) continue;
        for (const tag of ((op as Record<string, unknown>)["tags"] as string[] | undefined) ?? []) {
          assert.ok(declaradas.has(tag), `tag "${tag}" usada em ${method} ${url} e não declarada`);
        }
      }
    }
  });

  test("é serializável em JSON sem perder nada", () => {
    const round = JSON.parse(JSON.stringify(doc));
    assert.deepEqual(round, doc, "valores não serializáveis (undefined, Date) quebram o documento servido");
  });
});

describe("GET /v1/openapi", () => {
  const get = (url = "https://api.test/v1/openapi") => openapiEndpoint(new Request(url));

  test("devolve o documento em JSON, sem exigir chave", async () => {
    const res = await get();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["openapi"], "3.1.0");
    assert.ok(Object.keys(body["paths"] as object).length >= 15);
  });

  test("o servers usa PUBLIC_BASE_URL quando definido", async () => {
    restoreEnv = withEnv({ PUBLIC_BASE_URL: "https://apis.exemplo.com.br/" });
    const body = (await (await get()).json()) as { servers: { url: string }[] };
    assert.equal(body.servers[0]?.url, "https://apis.exemplo.com.br", "a barra final é removida");
  });

  test("sem PUBLIC_BASE_URL cai para a origem da requisição", async () => {
    restoreEnv = withEnv({ PUBLIC_BASE_URL: undefined });
    const body = (await (await get("https://local.test/v1/openapi")).json()) as { servers: { url: string }[] };
    assert.equal(body.servers[0]?.url, "https://local.test");
  });

  test("permite leitura de outro domínio, para renderizadores externos", async () => {
    assert.equal((await get()).headers.get("access-control-allow-origin"), "*");
  });
});
