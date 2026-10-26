import { clientIp } from "../lib/http.js";
import { countScan, getCode } from "../lib/qr.js";
import { rateLimitPerMinute } from "../lib/rateLimit.js";
import { getStore } from "../lib/store.js";

/**
 * Leituras por minuto por IP. Um QR legítimo atrás de um NAT corporativo pode somar bastante,
 * então o valor é folgado: a intenção é conter varredura de ids e enxurrada automatizada,
 * não policiar uso normal.
 */
const SCANS_PER_MINUTE = 60;

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Rota pública dos QR Codes dinâmicos: /r/:id (reescrita em vercel.json). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const store = getStore();

  // Rota pública e sem chave: cada leitura custa invocação e comandos no Redis, e os ids têm
  // só 7 caracteres (varredura é viável). O limite vem antes da busca para que a requisição
  // barrada não pague o custo que ela estava tentando provocar.
  //
  // Sem IP (fora da Vercel) o limite passa a ser por código, e não um balde único global:
  // um balde compartilhado derrubaria todos os links de uma vez se os headers faltassem.
  const ip = clientIp(req);
  const bucket = ip ? `rlr:ip:${ip}` : `rlr:code:${id}`;
  const limit = await rateLimitPerMinute(store, bucket, SCANS_PER_MINUTE);
  if (!limit.allowed) {
    return text(429, "Muitas leituras. Tente novamente em instantes.", {
      "retry-after": String(limit.retryAfter),
      "x-ratelimit-limit": String(limit.limit),
      "x-ratelimit-remaining": "0",
    });
  }

  const record = await getCode(store, id);
  if (!record) return text(404, "Link não encontrado.");

  await countScan(store, id);
  // 302 (e não 301) para que o destino possa ser alterado e cada leitura seja contada.
  return new Response(null, { status: 302, headers: { location: record.url, "cache-control": "no-store" } });
}
