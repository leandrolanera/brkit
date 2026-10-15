import { countScan, getCode } from "../lib/qr.js";
import { getStore } from "../lib/store.js";

/** Rota pública dos QR Codes dinâmicos: /r/:id (reescrita em vercel.json). */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const store = getStore();
  const record = await getCode(store, id);
  if (!record) {
    return new Response("Link não encontrado.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  await countScan(store, id);
  // 302 (e não 301) para que o destino possa ser alterado e cada leitura seja contada.
  return new Response(null, { status: 302, headers: { location: record.url, "cache-control": "no-store" } });
}
