import QRCode from "qrcode";
import { apiError, json, readJson } from "../../../lib/http.js";
import {
  createDynamicCode,
  getCode,
  isCodeId,
  scanCount,
  updateCodeTarget,
  validateTargetUrl,
} from "../../../lib/qr.js";
import { withApi } from "../../../lib/withApi.js";

function baseUrl(req: Request): string {
  return (process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin).replace(/\/$/, "");
}

function idParam(req: Request): string | null {
  const id = new URL(req.url).searchParams.get("id");
  return id && isCodeId(id) ? id : null;
}

/** POST /v1/qr/codes  { "url": "https://..." } — cria um QR Code dinâmico (destino editável). */
export const POST = withApi(async (req, { key, store }) => {
  const body = await readJson<{ url?: unknown }>(req);
  const target = validateTargetUrl(body?.url);
  if (!target) {
    return apiError(400, "invalid_url", "Envie { \"url\": \"https://...\" } com uma URL http(s) pública de até 2048 caracteres.");
  }

  const id = await createDynamicCode(store, target, key.id);
  const shortUrl = `${baseUrl(req)}/r/${id}`;
  const png = await QRCode.toBuffer(shortUrl, { type: "png", width: 512, margin: 2, errorCorrectionLevel: "M" });

  return json(
    {
      id,
      short_url: shortUrl,
      target_url: target,
      image_data_url: `data:image/png;base64,${png.toString("base64")}`,
    },
    201,
  );
});

/** GET /v1/qr/codes?id=... — dados e contagem de leituras de um QR Code seu. */
export const GET = withApi(async (req, { key, store }) => {
  const id = idParam(req);
  if (!id) return apiError(400, "invalid_id", "Informe o parâmetro id.");
  const record = await getCode(store, id);
  if (!record || record.owner !== key.id) return apiError(404, "not_found", "QR Code não encontrado.");

  return json({
    id,
    short_url: `${baseUrl(req)}/r/${id}`,
    target_url: record.url,
    scans: await scanCount(store, id),
    created_at: record.createdAt,
    updated_at: record.updatedAt ?? null,
  });
});

/** PATCH /v1/qr/codes?id=...  { "url": "https://..." } — troca o destino sem mudar a imagem do QR. */
export const PATCH = withApi(async (req, { key, store }) => {
  const id = idParam(req);
  if (!id) return apiError(400, "invalid_id", "Informe o parâmetro id.");
  const record = await getCode(store, id);
  if (!record || record.owner !== key.id) return apiError(404, "not_found", "QR Code não encontrado.");

  const body = await readJson<{ url?: unknown }>(req);
  const target = validateTargetUrl(body?.url);
  if (!target) return apiError(400, "invalid_url", "Envie { \"url\": \"https://...\" } com uma URL http(s) pública.");

  await updateCodeTarget(store, id, record, target);
  return json({ id, target_url: target });
});
