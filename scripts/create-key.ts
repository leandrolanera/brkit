/**
 * Cria uma chave de API.
 *   npm run create-key -- --owner cliente@exemplo.com --plan free
 * Precisa das credenciais do Redis (UPSTASH_REDIS_REST_URL/TOKEN) em .env ou .env.local
 * (na Vercel: `vercel env pull .env.local`).
 */
import { createApiKey } from "../lib/auth.js";
import { isPlanId, PLANS } from "../lib/plans.js";
import { getStore, usingMemoryStore } from "../lib/store.js";

for (const file of [".env", ".env.local"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // arquivo ausente: segue com as variáveis do ambiente
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const owner = arg("owner");
const plan = arg("plan") ?? "free";

if (!owner) {
  console.error("Uso: npm run create-key -- --owner <email-ou-nome> [--plan free|pro|scale]");
  process.exit(1);
}
if (!isPlanId(plan)) {
  console.error(`Plano inválido: ${plan}. Opções: ${Object.keys(PLANS).join(", ")}`);
  process.exit(1);
}
if (usingMemoryStore()) {
  console.error("Redis não configurado: sem UPSTASH_REDIS_REST_URL/TOKEN a chave não seria gravada em lugar nenhum.");
  process.exit(1);
}

const { key, record } = await createApiKey(getStore(), owner, plan);
console.log(`Chave criada para ${record.owner} (plano ${record.plan}, id ${record.id}).`);
console.log("Guarde agora, ela não será exibida de novo:");
console.log(key);
