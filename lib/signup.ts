import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createApiKey, type KeyRecord } from "./auth.js";
import type { EmailSender } from "./email.js";
import type { Store } from "./store.js";

/**
 * Cadastro público de chaves com verificação de e-mail.
 *
 * Fluxo: `POST /v1/signup` com o e-mail envia um código; `POST /v1/signup/verify` com e-mail e
 * código devolve a chave, uma única vez. A verificação existe para que uma chave free tenha
 * algum custo de obtenção — sem ela, criar chaves em massa seria trivial.
 */

/** Tempo para usar o código. Curto o bastante para limitar tentativas, longo para dar conta do e-mail atrasar. */
const CODE_TTL_SECONDS = 30 * 60;

/** Tentativas por código. Esgotadas, o código é invalidado e é preciso pedir outro. */
const MAX_ATTEMPTS = 5;

/**
 * Alfabeto sem caracteres ambíguos (sem O/0, I/1/L): o código vai ser lido de um e-mail e
 * digitado à mão. 8 posições em 32 símbolos tornam a força bruta irrelevante mesmo com o
 * limite de tentativas.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signupKey = (hash: string) => `signup:${hash}`;
const attemptsKey = (hash: string) => `signupatt:${hash}`;
const ownerKey = (hash: string) => `owner:${hash}`;

export class SignupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignupError";
  }
}

/** Normaliza para que `A@B.com ` e `a@b.com` sejam o mesmo cadastro. Devolve null se inválido. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

/** O e-mail nunca é gravado em claro: as chaves do Redis usam o hash. */
function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

/**
 * Normaliza aqui dentro, e não só no endpoint, porque o hash do e-mail é a identidade do
 * cadastro: um chamador que esquecesse de normalizar criaria registros separados para
 * `A@b.com` e `a@b.com`, e a regra de uma chave por e-mail cairia por terra.
 */
function requireEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (!email) throw new SignupError(400, "invalid_email", "E-mail inválido.");
  return email;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function generateCode(): string {
  let code = "";
  for (const byte of randomBytes(CODE_LENGTH)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function codeMatches(received: string, expectedHash: string): boolean {
  const a = Buffer.from(hashCode(received), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PendingSignup {
  codeHash: string;
  createdAt: string;
}

export interface SignupDeps {
  store: Store;
  email: EmailSender;
  now?: Date;
}

/** A verificação não envia e-mail, então não pede o remetente. */
export type VerifyDeps = Pick<SignupDeps, "store">;

/**
 * Pede um código de verificação.
 *
 * Responde igual exista ou não chave para o e-mail: revelar a diferença daria um oráculo para
 * descobrir quem está cadastrado. Quem já tem chave recebe um e-mail dizendo isso, em vez de
 * um código.
 */
export async function startSignup(deps: SignupDeps, rawEmail: string): Promise<void> {
  const { store } = deps;
  const email = requireEmail(rawEmail);
  const hash = hashEmail(email);

  if (await store.get<string>(ownerKey(hash))) {
    await deps.email.send({
      to: email,
      subject: "Sua chave de API já existe",
      text:
        "Recebemos um pedido de cadastro para este e-mail, mas já existe uma chave emitida para ele.\n\n" +
        "Se você perdeu a sua chave, responda este e-mail: por ora a recuperação é manual.\n\n" +
        "Se não foi você que pediu, pode ignorar esta mensagem.",
    });
    return;
  }

  const code = generateCode();
  const pending: PendingSignup = {
    codeHash: hashCode(code),
    createdAt: (deps.now ?? new Date()).toISOString(),
  };

  // Grava antes de enviar: se o envio falhar, o cliente repete e recebe um código novo, e o
  // registro antigo cai pelo TTL. O contrário poderia confirmar um código que nunca chegou.
  await store.set(signupKey(hash), pending, { exSeconds: CODE_TTL_SECONDS });
  await store.del(attemptsKey(hash));

  await deps.email.send({
    to: email,
    subject: "Seu código de verificação",
    text:
      `Seu código de verificação é:\n\n    ${code}\n\n` +
      `Ele vale por ${CODE_TTL_SECONDS / 60} minutos. Para concluir o cadastro, envie:\n\n` +
      `    POST /v1/signup/verify\n    { "email": "${email}", "code": "${code}" }\n\n` +
      "A chave de API aparece uma única vez, na resposta dessa chamada. Guarde-a com cuidado.\n\n" +
      "Se não foi você que pediu, pode ignorar esta mensagem.",
  });
}

export interface VerifyResult {
  /** Texto puro da chave. Só existe aqui: o que fica guardado é o hash. */
  api_key: string;
  record: KeyRecord;
}

/**
 * Confere o código e emite a chave.
 *
 * O contador de tentativas usa `incr`, que é atômico, então nem chamadas simultâneas furam o
 * limite. Esgotado, o código é apagado: quem errou cinco vezes pede outro.
 */
export async function verifySignup(deps: VerifyDeps, rawEmail: string, code: string): Promise<VerifyResult> {
  const { store } = deps;
  const email = requireEmail(rawEmail);
  const hash = hashEmail(email);

  if (await store.get<string>(ownerKey(hash))) {
    throw new SignupError(409, "key_already_issued", "Já existe uma chave emitida para este e-mail.");
  }

  const pending = await store.get<PendingSignup>(signupKey(hash));
  if (!pending) {
    throw new SignupError(
      400,
      "no_pending_signup",
      "Não há código pendente para este e-mail. Peça um novo em POST /v1/signup.",
    );
  }

  const attempts = await store.incr(attemptsKey(hash));
  if (attempts === 1) await store.expire(attemptsKey(hash), CODE_TTL_SECONDS);
  if (attempts > MAX_ATTEMPTS) {
    await store.del(signupKey(hash));
    throw new SignupError(429, "too_many_attempts", "Tentativas esgotadas. Peça um novo código em POST /v1/signup.");
  }

  if (typeof code !== "string" || !codeMatches(code, pending.codeHash)) {
    throw new SignupError(400, "invalid_code", "Código inválido.");
  }

  const { key, record } = await createApiKey(store, email, "free");
  // Índice de dono: é o que garante uma chave por e-mail. Gravado depois da chave, para não
  // bloquear o e-mail se a criação falhar no meio.
  await store.set(ownerKey(hash), record.id);
  await store.del(signupKey(hash));
  await store.del(attemptsKey(hash));

  return { api_key: key, record };
}
