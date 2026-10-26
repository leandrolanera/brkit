import * as redirect from "../handlers/redirect.js";
import * as v1BillingCheckout from "../handlers/v1/billing/checkout.js";
import * as v1Billing from "../handlers/v1/billing/index.js";
import * as v1BoletoDecode from "../handlers/v1/boleto/decode.js";
import * as v1Health from "../handlers/v1/health.js";
import * as v1HolidaysBusinessDays from "../handlers/v1/holidays/business-days.js";
import * as v1Holidays from "../handlers/v1/holidays/index.js";
import * as v1KeysRecover from "../handlers/v1/keys/recover/index.js";
import * as v1KeysRecoverVerify from "../handlers/v1/keys/recover/verify.js";
import * as v1KeysRotate from "../handlers/v1/keys/rotate.js";
import * as v1NfeDecode from "../handlers/v1/nfe/decode.js";
import * as v1NfeKey from "../handlers/v1/nfe/key.js";
import * as v1Openapi from "../handlers/v1/openapi.js";
import * as v1PaymentsDecode from "../handlers/v1/payments/decode.js";
import * as v1PixDecode from "../handlers/v1/pix/decode.js";
import * as v1PixQr from "../handlers/v1/pix/qr.js";
import * as v1QrCodes from "../handlers/v1/qr/codes.js";
import * as v1Qr from "../handlers/v1/qr/index.js";
import * as v1Signup from "../handlers/v1/signup/index.js";
import * as v1SignupVerify from "../handlers/v1/signup/verify.js";
import * as v1ValidateCnpj from "../handlers/v1/validate/cnpj.js";
import * as v1ValidateCpf from "../handlers/v1/validate/cpf.js";
import * as webhooksAsaas from "../handlers/webhooks/asaas.js";
import { apiError } from "./http.js";

type Handler = (request: Request) => Response | Promise<Response>;

/** Os módulos ficam fora de api/ para gerar somente uma função na Vercel. */
export const routes: Record<string, Record<string, Handler>> = {
  "/api/redirect": redirect,
  "/api/v1/billing/checkout": v1BillingCheckout,
  "/api/v1/billing": v1Billing,
  "/api/v1/boleto/decode": v1BoletoDecode,
  "/api/v1/health": v1Health,
  "/api/v1/holidays/business-days": v1HolidaysBusinessDays,
  "/api/v1/holidays": v1Holidays,
  "/api/v1/keys/recover": v1KeysRecover,
  "/api/v1/keys/recover/verify": v1KeysRecoverVerify,
  "/api/v1/keys/rotate": v1KeysRotate,
  "/api/v1/nfe/decode": v1NfeDecode,
  "/api/v1/nfe/key": v1NfeKey,
  "/api/v1/openapi": v1Openapi,
  "/api/v1/payments/decode": v1PaymentsDecode,
  "/api/v1/pix/decode": v1PixDecode,
  "/api/v1/pix/qr": v1PixQr,
  "/api/v1/qr/codes": v1QrCodes,
  "/api/v1/qr": v1Qr,
  "/api/v1/signup": v1Signup,
  "/api/v1/signup/verify": v1SignupVerify,
  "/api/v1/validate/cnpj": v1ValidateCnpj,
  "/api/v1/validate/cpf": v1ValidateCpf,
  "/api/webhooks/asaas": webhooksAsaas,
};

export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let path = url.pathname.replace(/\/$/, "");
  if (path.startsWith("/v1/")) path = `/api${path}`;
  if (path === "/api/v1/openapi.json") path = "/api/v1/openapi";

  const redirect = /^\/r\/([^/]+)$/.exec(path);
  if (redirect) {
    path = "/api/redirect";
    url.searchParams.set("id", redirect[1]!);
    request = new Request(url, request);
  }

  const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
  if (!route) return apiError(404, "not_found", "Rota não encontrada.");
  const method = request.method === "HEAD" ? "GET" : request.method;
  const handler = Object.hasOwn(route, method) ? route[method] : undefined;
  if (!handler) {
    const allow = Object.keys(route);
    if (route.GET) allow.push("HEAD");
    return apiError(405, "method_not_allowed", "Método não permitido.", { allow: allow.join(", ") });
  }
  const response = await handler(request);
  return request.method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
