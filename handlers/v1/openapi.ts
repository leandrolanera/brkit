import { json } from "../../lib/http.js";
import { buildOpenApiDocument } from "../../lib/openapi.js";

/**
 * GET /v1/openapi (e `/v1/openapi.json`, pela reescrita em vercel.json)
 *
 * Pública de propósito: a documentação precisa ser legível por quem ainda não tem chave.
 *
 * O `servers` sai de PUBLIC_BASE_URL quando definido, senão da origem da própria requisição —
 * assim o documento serve tanto em produção quanto em desenvolvimento, sem configuração.
 */
export function GET(req: Request) {
  const base = (process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  return json(buildOpenApiDocument(base), 200, {
    "cache-control": "public, max-age=300",
    // Permite que um renderizador aberto em outro domínio (Scalar, Redoc, Swagger UI) leia o doc.
    "access-control-allow-origin": "*",
  });
}
