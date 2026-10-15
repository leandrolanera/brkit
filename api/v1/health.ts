import { json } from "../../lib/http.js";

export function GET() {
  return json({ status: "ok", time: new Date().toISOString() }, 200, { "cache-control": "no-store" });
}
