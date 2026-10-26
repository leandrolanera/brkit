import QRCode from "qrcode";
import { apiError, json, readJson } from "../../../lib/http.js";
import { buildBrCode, normalizePixKey, PixError } from "../../../lib/pix.js";
import { withApi } from "../../../lib/withApi.js";

interface Body {
  key?: unknown;
  name?: unknown;
  city?: unknown;
  amount?: unknown;
  txid?: unknown;
  description?: unknown;
  reusable?: unknown;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * POST /v1/pix/qr
 * { "key": "...", "name": "...", "city": "...", "amount": 49.9, "txid": "PEDIDO123", "description": "..." }
 *
 * Devolve o BR Code ("Pix copia e cola") e a imagem em PNG. Gerado offline, sem falar com
 * banco nem PSP: o payload é só o padrão EMV do BACEN mais o CRC.
 *
 * Só aceita POST: a chave Pix de uma pessoa física é dado pessoal e query string vai para log.
 * Para controlar formato, tamanho ou correção de erro da imagem, mande o `br_code` daqui
 * para `GET /v1/qr?data=...`.
 */
export const POST = withApi(async (req) => {
  const body = await readJson<Body>(req);
  if (!body || typeof body !== "object") {
    return apiError(400, "invalid_body", "Envie um corpo JSON com key, name e city.");
  }

  const key = str(body.key);
  const name = str(body.name);
  const city = str(body.city);
  if (!key || !name || !city) {
    return apiError(400, "missing_fields", "key, name e city são obrigatórios.");
  }

  if (body.amount !== undefined && typeof body.amount !== "number") {
    return apiError(400, "invalid_amount", "amount deve ser um número em reais (ex.: 49.9).");
  }
  if (body.reusable !== undefined && typeof body.reusable !== "boolean") {
    return apiError(400, "invalid_reusable", "reusable deve ser true ou false.");
  }
  for (const field of ["txid", "description"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return apiError(400, `invalid_${field}`, `${field} deve ser uma string.`);
    }
  }

  try {
    const brCode = buildBrCode({
      key,
      name,
      city,
      amount: body.amount as number | undefined,
      txid: str(body.txid),
      description: str(body.description),
      reusable: body.reusable as boolean | undefined,
    });

    const png = await QRCode.toBuffer(brCode, {
      type: "png",
      width: 512,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    return json(
      {
        br_code: brCode,
        key_type: normalizePixKey(key)?.type ?? null,
        image_data_url: `data:image/png;base64,${png.toString("base64")}`,
      },
      201,
    );
  } catch (err) {
    // PixError carrega os limites da especificação; qualquer outro erro sobe e vira 500.
    if (err instanceof PixError) return apiError(400, err.code, err.message);
    throw err;
  }
});
