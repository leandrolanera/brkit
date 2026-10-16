import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createApiKey, rotateApiKey, type KeyRecord } from "./auth.js";
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

/**
 * Para que serve o código. Namespacear o armazenamento por propósito impede que um código
 * pedido para criar chave sirva para rotacionar a de outra pessoa, e vice-versa.
 */
type Purpose = "signup" | "recover";

const pendingKey = (purpose: Purpose, hash: string) => `${purpose}:${hash}`;
const attemptsKey = (purpose: Purpose, hash: string) => `${purpose}att:${hash}`;
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
export type VerifyDeps = Pick<SignupDeps, "store" | "now">;

/**
 * Sorteia um código, grava o hash dele com prazo e zera o contador de tentativas.
 * Gravar antes de enviar: se o envio falhar, o cliente repete e recebe um código novo, e o
 * registro antigo cai pelo TTL. O contrário poderia confirmar um código que nunca chegou.
 */
async function issueCode(store: Store, purpose: Purpose, hash: string, now: Date): Promise<string> {
  const code = generateCode();
  const pending: PendingSignup = { codeHash: hashCode(code), createdAt: now.toISOString() };
  await store.set(pendingKey(purpose, hash), pending, { exSeconds: CODE_TTL_SECONDS });
  await store.del(attemptsKey(purpose, hash));
  return code;
}

/**
 * Confere o código e o consome.
 *
 * O contador de tentativas usa `incr`, que é atômico, então nem chamadas simultâneas furam o
 * limite. Esgotado, o código é apagado: quem errou cinco vezes pede outro.
 */
async function consumeCode(store: Store, purpose: Purpose, hash: string, code: string): Promise<void> {
  const pending = await store.get<PendingSignup>(pendingKey(purpose, hash));
  if (!pending) {
    throw new SignupError(
      400,
      "no_pending_code",
      "Não há código pendente para este e-mail. Peça um novo antes de verificar.",
    );
  }

  const attempts = await store.incr(attemptsKey(purpose, hash));
  if (attempts === 1) await store.expire(attemptsKey(purpose, hash), CODE_TTL_SECONDS);
  if (attempts > MAX_ATTEMPTS) {
    await store.del(pendingKey(purpose, hash));
    throw new SignupError(429, "too_many_attempts", "Tentativas esgotadas. Peça um novo código.");
  }

  if (typeof code !== "string" || !codeMatches(code, pending.codeHash)) {
    throw new SignupError(400, "invalid_code", "Código inválido.");
  }

  await store.del(pendingKey(purpose, hash));
  await store.del(attemptsKey(purpose, hash));
}

/**
 * Pede um código para criar uma chave.
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
        "Se você perdeu a sua chave, peça uma nova em POST /v1/keys/recover com este mesmo e-mail:\n" +
        "a chave atual será substituída.\n\n" +
        "Se não foi você que pediu, pode ignorar esta mensagem.",
    });
    return;
  }

  const code = await issueCode(store, "signup", hash, deps.now ?? new Date());
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

/**
 * Pede um código para substituir a chave de um e-mail que já tem uma.
 *
 * Mesma política de não revelar: e-mail sem chave recebe uma mensagem orientando o cadastro,
 * em vez de um código, e a resposta HTTP é a mesma nos dois casos.
 */
export async function startRecovery(deps: SignupDeps, rawEmail: string): Promise<void> {
  const { store } = deps;
  const email = requireEmail(rawEmail);
  const hash = hashEmail(email);

  if (!(await store.get<string>(ownerKey(hash)))) {
    await deps.email.send({
      to: email,
      subject: "Não há chave para este e-mail",
      text:
        "Recebemos um pedido de nova chave para este e-mail, mas não existe chave emitida para ele.\n\n" +
        "Para criar uma, envie POST /v1/signup com este endereço.\n\n" +
        "Se não foi você que pediu, pode ignorar esta mensagem.",
    });
    return;
  }

  const code = await issueCode(store, "recover", hash, deps.now ?? new Date());
  await deps.email.send({
    to: email,
    subject: "Código para substituir sua chave de API",
    text:
      `Seu código é:\n\n    ${code}\n\n` +
      `Ele vale por ${CODE_TTL_SECONDS / 60} minutos. Para receber a chave nova, envie:\n\n` +
      `    POST /v1/keys/recover/verify\n    { "email": "${email}", "code": "${code}" }\n\n` +
      "ATENÇÃO: ao concluir, a chave atual deixa de funcionar na hora. Plano, cota do mês, " +
      "QR Codes e assinatura são preservados.\n\n" +
      "Se não foi você que pediu, ignore esta mensagem — sua chave atual segue valendo.",
  });
}

export interface VerifyResult {
  /** Texto puro da chave. Só existe aqui: o que fica guardado é o hash. */
  api_key: string;
  record: KeyRecord;
}

/**
 * Confere o código e emite a chave nova do cadastro.
 */
export async function verifySignup(deps: VerifyDeps, rawEmail: string, code: string): Promise<VerifyResult> {
  const { store } = deps;
  const email = requireEmail(rawEmail);
  const hash = hashEmail(email);

  // O código vem PRIMEIRO, de propósito. Checar a existência da chave antes daria um oráculo
  // de enumeração: com um código qualquer dava para separar "este e-mail tem chave" (409) de
  // "não tem" (400), anulando a razão de `POST /v1/signup` responder 202 nos dois casos.
  // Exigindo o código antes, só descobre quem já controla a caixa de entrada.
  await consumeCode(store, "signup", hash, code);

  if (await store.get<string>(ownerKey(hash))) {
    throw new SignupError(
      409,
      "key_already_issued",
      "Já existe uma chave emitida para este e-mail. Para substituí-la, use POST /v1/keys/recover.",
    );
  }

  const { key, record } = await createApiKey(store, email, "free");
  // Índice de dono: é o que garante uma chave por e-mail. Gravado depois da chave, para não
  // bloquear o e-mail se a criação falhar no meio.
  await store.set(ownerKey(hash), record.id);

  return { api_key: key, record };
}

/**
 * Confere o código e substitui a chave do e-mail.
 *
 * É o caminho para quem perdeu a chave: o e-mail é a identidade, então quem prova acesso a ele
 * recebe uma chave nova. O id é preservado, e com ele o plano, a cota do mês, os QR Codes e o
 * vínculo com a assinatura — ver rotateApiKey.
 */
export async function verifyRecovery(deps: VerifyDeps, rawEmail: string, code: string): Promise<VerifyResult> {
  const { store } = deps;
  const email = requireEmail(rawEmail);
  const hash = hashEmail(email);

  const keyId = await store.get<string>(ownerKey(hash));
  if (!keyId) {
    throw new SignupError(
      404,
      "no_key_for_email",
      "Não há chave emitida para este e-mail. Use POST /v1/signup para criar uma.",
    );
  }

  await consumeCode(store, "recover", hash, code);

  const rotated = await rotateApiKey(store, keyId, deps.now ?? new Date());
  if (!rotated) {
    // Índice de dono apontando para uma chave inexistente: estado inconsistente, não um erro
    // do cliente. Deixa alto para aparecer no log.
    throw new SignupError(500, "key_missing", "A chave vinculada a este e-mail não foi encontrada.");
  }

  return { api_key: rotated.key, record: rotated.record };
}
