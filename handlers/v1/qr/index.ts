import QRCode from "qrcode";
import { apiError, intParam } from "../../../lib/http.js";
import { withApi } from "../../../lib/withApi.js";

const ECC_LEVELS = ["L", "M", "Q", "H"] as const;
type Ecc = (typeof ECC_LEVELS)[number];

/** GET /v1/qr?data=...&format=png|svg&size=256&margin=2&ecc=M — QR Code estático. */
export const GET = withApi(async (req) => {
  const p = new URL(req.url).searchParams;

  const data = p.get("data");
  if (!data) return apiError(400, "missing_data", "O parâmetro data é obrigatório.");
  if (data.length > 1000) return apiError(400, "data_too_long", "data aceita até 1000 caracteres.");

  const format = p.get("format") ?? "png";
  if (format !== "png" && format !== "svg") {
    return apiError(400, "invalid_format", "format deve ser png ou svg.");
  }

  const size = intParam(p.get("size"), 64, 1024, 256);
  if (size === null) return apiError(400, "invalid_size", "size deve ser um inteiro entre 64 e 1024.");

  const margin = intParam(p.get("margin"), 0, 10, 2);
  if (margin === null) return apiError(400, "invalid_margin", "margin deve ser um inteiro entre 0 e 10.");

  const ecc = (p.get("ecc") ?? "M").toUpperCase();
  if (!ECC_LEVELS.includes(ecc as Ecc)) return apiError(400, "invalid_ecc", "ecc deve ser L, M, Q ou H.");

  const options = { errorCorrectionLevel: ecc as Ecc, margin, width: size };
  const cache = { "cache-control": "public, max-age=86400" };

  try {
    if (format === "svg") {
      const svg = await QRCode.toString(data, { ...options, type: "svg" });
      return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", ...cache } });
    }
    const png = await QRCode.toBuffer(data, { ...options, type: "png" });
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", ...cache } });
  } catch {
    return apiError(400, "data_too_large", "O conteúdo não cabe em um QR Code com esse nível de correção.");
  }
});
