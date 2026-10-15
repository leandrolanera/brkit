export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers);
}

export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/**
 * IP público do cliente, para limitar rotas sem chave de API.
 *
 * A Vercel sobrescreve o `x-forwarded-for` com um único IP e não repassa IPs externos,
 * justamente para impedir spoofing. O `x-vercel-forwarded-for` é idêntico mas não pode ser
 * sobrescrito por um proxy na frente da Vercel, então vem primeiro.
 * No fallback do `x-forwarded-for` usamos a última entrada: cada proxy acrescenta o endereço
 * de quem falou com ele, então a mais à direita foi posta pelo proxy mais próximo — as da
 * esquerda podem vir forjadas pelo cliente.
 *
 * Devolve null fora da Vercel (ex.: desenvolvimento local), onde nenhum desses headers existe.
 */
export function clientIp(req: Request): string | null {
  for (const header of ["x-vercel-forwarded-for", "x-real-ip"]) {
    const value = req.headers.get(header)?.trim();
    if (value) return value;
  }
  const chain = req.headers.get("x-forwarded-for")?.split(",") ?? [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const value = chain[i]?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Lê um parâmetro inteiro com limites.
 * Retorna o padrão se ausente, e null se presente porém inválido ou fora do intervalo.
 */
export function intParam(raw: string | null, min: number, max: number, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}
