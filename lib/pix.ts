/**
 * BR Code do Pix, conforme o Manual de Padrões para Iniciação do Pix (BACEN), que adota o
 * padrão EMV QRCPS em modo Merchant-Presented.
 *
 * O payload é uma sequência de campos TLV: ID de 2 dígitos, tamanho de 2 dígitos, valor.
 * Como o tamanho tem só 2 dígitos, nenhum valor passa de 99 caracteres — é daí que vêm
 * quase todos os limites deste arquivo.
 */

import { isValidCnpj, isValidCpf } from "./validators.js";

/** Globally Unique Identifier do arranjo Pix, no campo 26. */
export const PIX_GUI = "br.gov.bcb.pix";

const ID_FORMAT = "00";
const ID_INITIATION = "01";
const ID_MERCHANT_ACCOUNT = "26";
const ID_CATEGORY = "52";
const ID_CURRENCY = "53";
const ID_AMOUNT = "54";
const ID_COUNTRY = "58";
const ID_NAME = "59";
const ID_CITY = "60";
const ID_ADDITIONAL = "62";
const ID_CRC = "63";

const SUB_GUI = "00";
const SUB_KEY = "01";
const SUB_DESCRIPTION = "02";
const SUB_URL = "25";
const SUB_TXID = "05";

/** Tamanho máximo de qualquer valor TLV: o campo de tamanho tem 2 dígitos. */
const MAX_TLV_VALUE = 99;

export const LIMITS = {
  name: 25,
  city: 15,
  txid: 25,
  /** "9999999999.99" — 13 caracteres. */
  amount: 13,
  /** O campo 26 inteiro (GUI + chave + descrição, com os cabeçalhos) não passa de 99. */
  merchantAccount: MAX_TLV_VALUE,
} as const;

export type PixKeyType = "cpf" | "cnpj" | "phone" | "email" | "random";

export class PixError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PixError";
  }
}

/**
 * CRC-16/CCITT-FALSE: polinômio 0x1021, valor inicial 0xFFFF, sem reflexão e sem xor final.
 *
 * O "6304" (ID 63 + tamanho 04) faz parte da entrada do cálculo. Calcular o CRC sobre o
 * payload sem esse sufixo e só depois concatenar "6304" gera um código que banco nenhum
 * aceita — é o erro mais comum nas implementações por aí. O teste cobre justamente isso.
 */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Monta um campo TLV. Lança se o valor não couber nos 2 dígitos de tamanho. */
function tlv(id: string, value: string): string {
  if (value.length > MAX_TLV_VALUE) {
    throw new PixError("field_too_long", `O campo ${id} excede ${MAX_TLV_VALUE} caracteres.`);
  }
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/**
 * Lê uma sequência TLV. Devolve null se estiver malformada (tamanho inválido, valor truncado
 * ou ID repetido no mesmo nível, que a especificação não permite).
 */
export function parseTlv(payload: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < payload.length) {
    // Cabeçalho = 2 dígitos de ID + 2 de tamanho.
    if (i + 4 > payload.length) return null;
    const id = payload.slice(i, i + 2);
    const rawLength = payload.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(rawLength)) return null;
    const length = Number(rawLength);
    const start = i + 4;
    if (start + length > payload.length) return null;
    if (fields.has(id)) return null;
    fields.set(id, payload.slice(start, start + length));
    i = start + length;
  }
  return fields;
}

/**
 * Remove acentos e deixa só ASCII imprimível: a especificação pede nome e cidade sem
 * acentuação, e caractere fora disso quebra a leitura em parte dos apps.
 */
export function sanitizeText(input: string): string {
  return input
    .normalize("NFD")
    // Marcas diacríticas combinantes, separadas do caractere base pelo NFD.
    .replace(/[\u0300-\u036f]/g, "")
    // Descarta o que n\u00e3o \u00e9 ASCII imprim\u00edvel, mas preserva espa\u00e7o em branco: filtrar antes de
    // colapsar faria "Maria\tSouza" virar "MariaSouza", fundindo as duas palavras.
    .replace(/[^\x20-\x7e\s]/g, "")
    // Tab, quebra de linha e espa\u00e7os repetidos (inclusive os que o filtro deixou) viram um s\u00f3.
    .replace(/\s+/g, " ")
    .trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Identifica e normaliza a chave Pix na forma em que ela entra no BR Code.
 *
 * CPF e CNPJ vão só com dígitos; telefone em E.164 (+55 e DDD); chave aleatória (EVP) é um
 * UUID. Devolve null se não casar com nenhum tipo — chave errada gera um QR que falha só na
 * hora do pagamento, então é melhor recusar aqui.
 */
export function normalizePixKey(raw: string): { type: PixKeyType; key: string } | null {
  const value = raw.trim();
  if (!value) return null;

  if (UUID.test(value)) return { type: "random", key: value.toLowerCase() };

  if (value.includes("@")) {
    // A especificação reserva 77 caracteres para a chave de e-mail.
    if (value.length > 77 || !EMAIL.test(value)) return null;
    return { type: "email", key: value };
  }

  const digits = value.replace(/\D/g, "");

  if (value.startsWith("+")) {
    // E.164 do Brasil: 55 + DDD (2) + número (8 ou 9).
    if (!/^55\d{10,11}$/.test(digits)) return null;
    return { type: "phone", key: `+${digits}` };
  }

  if (digits.length === 11 && isValidCpf(digits)) return { type: "cpf", key: digits };
  if (digits.length === 14 && isValidCnpj(digits)) return { type: "cnpj", key: digits };

  return null;
}

/** Formata o valor como o campo 54 exige: ponto decimal, sem separador de milhar, sem R$. */
export function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

export interface BrCodeInput {
  key: string;
  /** Nome do beneficiário (campo 59). */
  name: string;
  /** Cidade do beneficiário (campo 60). */
  city: string;
  /** Valor em reais. Ausente deixa o pagador digitar o valor. */
  amount?: number;
  /** Identificador da transação (campo 62-05). Ausente vira "***". */
  txid?: string;
  /** Informação adicional (campo 26-02), exibida por parte dos apps. */
  description?: string;
  /** false marca o código como de uso único (campo 01 = "12"). */
  reusable?: boolean;
}

/**
 * Monta o BR Code estático ("Pix copia e cola") e devolve o payload já com o CRC.
 *
 * Valida tudo aqui dentro porque os limites vêm da especificação, não da API: deixar isso no
 * endpoint espalharia a regra. Lança PixError, que o endpoint traduz em 400.
 */
export function buildBrCode(input: BrCodeInput): string {
  const key = normalizePixKey(input.key);
  if (!key) {
    throw new PixError(
      "invalid_key",
      "key deve ser um CPF, CNPJ, telefone (+55DDNNNNNNNNN), e-mail ou chave aleatória (UUID) válidos.",
    );
  }

  const name = sanitizeText(input.name);
  if (!name || name.length > LIMITS.name) {
    throw new PixError("invalid_name", `name é obrigatório e aceita até ${LIMITS.name} caracteres sem acento.`);
  }

  const city = sanitizeText(input.city);
  if (!city || city.length > LIMITS.city) {
    throw new PixError("invalid_city", `city é obrigatória e aceita até ${LIMITS.city} caracteres sem acento.`);
  }

  let amount: string | null = null;
  if (input.amount !== undefined) {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new PixError("invalid_amount", "amount deve ser um número maior que zero, em reais.");
    }
    amount = formatAmount(input.amount);
    if (amount.length > LIMITS.amount) {
      throw new PixError("invalid_amount", "amount excede o máximo que o campo aceita.");
    }
  }

  // txid estático aceita só alfanumérico; "***" é o marcador de "sem identificador".
  let txid = "***";
  if (input.txid !== undefined && input.txid !== "" && input.txid !== "***") {
    if (!/^[A-Za-z0-9]{1,25}$/.test(input.txid)) {
      throw new PixError("invalid_txid", `txid aceita até ${LIMITS.txid} caracteres alfanuméricos.`);
    }
    txid = input.txid;
  }

  const description = input.description === undefined ? null : sanitizeText(input.description) || null;

  let merchantAccount = tlv(SUB_GUI, PIX_GUI) + tlv(SUB_KEY, key.key);
  if (description) merchantAccount += tlv(SUB_DESCRIPTION, description);
  if (merchantAccount.length > LIMITS.merchantAccount) {
    // Sobra para chave + descrição depois de descontar GUI e cabeçalhos.
    const budget = LIMITS.merchantAccount - (tlv(SUB_GUI, PIX_GUI).length + 4 + key.key.length + 4);
    throw new PixError(
      "fields_too_long",
      `A chave e a descrição não cabem no campo 26: com essa chave, description aceita até ${Math.max(0, budget)} caracteres.`,
    );
  }

  let payload =
    tlv(ID_FORMAT, "01") +
    tlv(ID_INITIATION, input.reusable === false ? "12" : "11") +
    tlv(ID_MERCHANT_ACCOUNT, merchantAccount) +
    tlv(ID_CATEGORY, "0000") +
    tlv(ID_CURRENCY, "986");
  if (amount) payload += tlv(ID_AMOUNT, amount);
  payload +=
    tlv(ID_COUNTRY, "BR") +
    tlv(ID_NAME, name) +
    tlv(ID_CITY, city) +
    tlv(ID_ADDITIONAL, tlv(SUB_TXID, txid));

  // O ID e o tamanho do próprio campo 63 entram no cálculo do CRC.
  const withCrcHeader = `${payload}${ID_CRC}04`;
  return `${withCrcHeader}${crc16(withCrcHeader)}`;
}

export interface DecodedBrCode {
  /** CRC confere e os campos obrigatórios estão presentes. */
  valid: boolean;
  crc_valid: boolean;
  /** dynamic = o payload aponta para uma URL (campo 26-25) em vez de trazer os dados. */
  kind: "static" | "dynamic";
  /** false quando o campo 01 marca uso único ("12"). */
  reusable: boolean;
  key: string | null;
  key_type: PixKeyType | null;
  merchant_name: string | null;
  merchant_city: string | null;
  amount: number | null;
  txid: string | null;
  description: string | null;
  payload_url: string | null;
  currency: string | null;
  country: string | null;
}

/**
 * Decodifica e verifica um BR Code (o "copia e cola").
 *
 * Devolve null só quando o payload não é TLV válido. Payload bem formado mas com CRC errado
 * ou campo obrigatório faltando volta com `valid: false` e o que deu para ler — é mais útil
 * para quem está depurando do que um erro seco.
 */
export function parseBrCode(payload: string): DecodedBrCode | null {
  const trimmed = payload.trim();
  // O CRC são os 4 últimos caracteres, precedidos de "6304".
  if (trimmed.length < 8) return null;
  const fields = parseTlv(trimmed);
  if (!fields) return null;

  const crcField = fields.get(ID_CRC);
  // O campo 63 é obrigatoriamente o último, então os 8 caracteres finais são "6304" + CRC.
  // Ancorar pelo fim (em vez de procurar "6304" no texto) também cobre o caso em que o
  // próprio valor do CRC é "6304", que terminaria o payload em "63046304".
  const header = trimmed.length - 8;
  const crcValid =
    crcField !== undefined &&
    header >= 0 &&
    trimmed.slice(header, header + 4) === `${ID_CRC}04` &&
    crc16(trimmed.slice(0, header + 4)).toUpperCase() === crcField.toUpperCase();

  const merchant = fields.get(ID_MERCHANT_ACCOUNT);
  const account = merchant ? parseTlv(merchant) : null;
  const rawKey = account?.get(SUB_KEY)?.trim() ?? null;
  const normalized = rawKey ? normalizePixKey(rawKey) : null;
  const payloadUrl = account?.get(SUB_URL)?.trim() ?? null;

  const additional = fields.get(ID_ADDITIONAL);
  const rawTxid = additional ? (parseTlv(additional)?.get(SUB_TXID)?.trim() ?? null) : null;

  const rawAmount = fields.get(ID_AMOUNT);
  const amount = rawAmount !== undefined && /^\d+(\.\d{1,2})?$/.test(rawAmount) ? Number(rawAmount) : null;

  const name = fields.get(ID_NAME)?.trim() || null;
  const city = fields.get(ID_CITY)?.trim() || null;
  const kind = payloadUrl ? "dynamic" : "static";

  // Um BR Code dinâmico carrega a URL no lugar da chave e do valor, então o mínimo exigido muda.
  const complete =
    fields.get(ID_FORMAT) === "01" && (kind === "dynamic" ? Boolean(payloadUrl) : Boolean(rawKey && name && city));

  return {
    valid: crcValid && complete,
    crc_valid: crcValid,
    kind,
    reusable: fields.get(ID_INITIATION) !== "12",
    key: rawKey,
    key_type: normalized?.type ?? null,
    merchant_name: name,
    merchant_city: city,
    amount,
    txid: rawTxid === "***" ? null : rawTxid,
    description: account?.get(SUB_DESCRIPTION)?.trim() || null,
    payload_url: payloadUrl,
    currency: fields.get(ID_CURRENCY) ?? null,
    country: fields.get(ID_COUNTRY) ?? null,
  };
}
