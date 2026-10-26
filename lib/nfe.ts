import { isValidCnpj, normalizeCnpj } from "./validators.js";

/**
 * Chave de acesso dos documentos fiscais eletrônicos: NF-e, NFC-e, CT-e e MDF-e.
 *
 * São 44 caracteres, e o 44º é dígito verificador por módulo 11 sobre os 43 anteriores.
 *
 * Desde a NT 2026.004 (produção em 01/07/2026) a chave acompanha o CNPJ alfanumérico: as 12
 * posições de raiz e ordem do CNPJ aceitam letras, e o cálculo do DV passou a valer cada
 * caractere pelo código ASCII menos 48 — o mesmo esquema que `lib/validators.ts` já usa no
 * CNPJ. Os 6 primeiros caracteres (cUF e AAMM) e os 26 finais seguem numéricos.
 *
 * Atenção à borda do módulo 11 daqui: **resto 0 ou 1 resulta em DV 0**. É a regra da
 * arrecadação, e não a do boleto de cobrança, onde esses restos dão DV 1. Trocar uma pela
 * outra só erra em alguns códigos, o que torna o engano especialmente silencioso.
 */

/** 6 numéricos (cUF+AAMM), 12 alfanuméricos (raiz e ordem do CNPJ), 26 numéricos. */
const KEY_PATTERN = /^\d{6}[A-Z0-9]{12}\d{26}$/;

export const KEY_LENGTH = 44;

/** Códigos de UF do IBGE, usados na 1ª e 2ª posições. */
const UF_BY_CODE: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL", "28": "SE", "29": "BA",
  "31": "MG", "32": "ES", "33": "RJ", "35": "SP",
  "41": "PR", "42": "SC", "43": "RS",
  "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

const CODE_BY_UF: Record<string, string> = Object.fromEntries(
  Object.entries(UF_BY_CODE).map(([code, uf]) => [uf, code]),
);

/**
 * Modelos de documento. Tabela deliberadamente curta: só os quatro confirmados na
 * especificação. Modelo fora dela volta com `model_name: null`, em vez de um nome inventado.
 */
const MODEL_NAMES: Record<string, string> = {
  "55": "NF-e",
  "57": "CT-e",
  "58": "MDF-e",
  "65": "NFC-e",
};

/** Formas de emissão. Também parcial: o que não está aqui volta como null. */
const EMISSION_NAMES: Record<string, string> = {
  "1": "Normal",
  "2": "Contingência FS-IA",
  "4": "Contingência EPEC",
  "5": "Contingência FS-DA",
  "6": "Contingência SVC-AN",
  "7": "Contingência SVC-RS",
  "9": "Contingência offline (NFC-e)",
};

export class NfeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NfeError";
  }
}

/**
 * Dígito verificador da chave: módulo 11 sobre as 43 primeiras posições, pesos 2 a 9 da
 * direita para a esquerda, cada caractere valendo o código ASCII menos 48 (assim `0`–`9`
 * seguem valendo 0–9 e `A`–`Z` valem 17–42).
 *
 * Resto 0 ou 1 resulta em 0; nos demais, 11 menos o resto.
 */
export function accessKeyCheckDigit(base43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = base43.length - 1; i >= 0; i--) {
    sum += (base43.charCodeAt(i) - 48) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest <= 1 ? 0 : 11 - rest;
}

/** Tira pontuação e espaço, e sobe as letras para maiúsculas. */
export function normalizeAccessKey(input: string): string {
  return input.replace(/[\s.\-/]/g, "").toUpperCase();
}

export interface DecodedAccessKey {
  /** Estrutura, dígito da chave e dígitos do CNPJ, todos conferindo. */
  valid: boolean;
  /** Só o dígito verificador da chave. */
  check_digit_valid: boolean;
  /** A chave normalizada: sem pontuação, em maiúsculas. */
  key: string;
  uf_code: string;
  /** Sigla da UF, ou null se o código não for de nenhum estado. */
  uf: string | null;
  /** Emissão, no formato AAAA-MM. */
  issued: string;
  cnpj: string;
  cnpj_kind: "numeric" | "alphanumeric";
  /** Dígitos verificadores do CNPJ embutido conferem. */
  cnpj_valid: boolean;
  model: string;
  /** Nome do modelo, ou null fora da tabela (NF-e, NFC-e, CT-e, MDF-e). */
  model_name: string | null;
  series: string;
  number: string;
  emission_type: string;
  emission_type_name: string | null;
  /** cNF: código numérico aleatório que o emitente sorteia. */
  random_code: string;
  check_digit: string;
  errors: string[];
}

/**
 * Lê e confere uma chave de acesso.
 *
 * Devolve null quando o conteúdo não tem 44 caracteres no formato da chave. Formato certo com
 * dígito errado volta com `valid: false`, o motivo em `errors` e todos os campos que deram para
 * ler — quem está conferindo uma chave digitada errada precisa ver onde está o problema.
 */
export function parseAccessKey(input: string): DecodedAccessKey | null {
  const key = normalizeAccessKey(input);
  if (!KEY_PATTERN.test(key)) return null;

  const errors: string[] = [];

  const expected = accessKeyCheckDigit(key.slice(0, 43));
  const checkDigitValid = Number(key[43]) === expected;
  if (!checkDigitValid) errors.push("invalid_check_digit");

  const ufCode = key.slice(0, 2);
  const uf = UF_BY_CODE[ufCode] ?? null;
  if (!uf) errors.push("unknown_uf_code");

  // AAMM: o ano vem com dois dígitos e a chave só existe a partir de 2006, então 00-99 mapeia
  // em 2000-2099 sem ambiguidade prática.
  const year = `20${key.slice(2, 4)}`;
  const month = key.slice(4, 6);
  if (Number(month) < 1 || Number(month) > 12) errors.push("invalid_month");

  const cnpj = key.slice(6, 20);
  const cnpjValid = isValidCnpj(cnpj);
  if (!cnpjValid) errors.push("invalid_cnpj");

  const model = key.slice(20, 22);
  const modelName = MODEL_NAMES[model] ?? null;

  const emissionType = key.slice(34, 35);

  return {
    valid: errors.length === 0,
    check_digit_valid: checkDigitValid,
    key,
    uf_code: ufCode,
    uf,
    issued: `${year}-${month}`,
    cnpj: normalizeCnpj(cnpj),
    cnpj_kind: /[A-Z]/.test(cnpj.slice(0, 12)) ? "alphanumeric" : "numeric",
    cnpj_valid: cnpjValid,
    model,
    model_name: modelName,
    series: key.slice(22, 25),
    number: key.slice(25, 34),
    emission_type: emissionType,
    emission_type_name: EMISSION_NAMES[emissionType] ?? null,
    random_code: key.slice(35, 43),
    check_digit: key.slice(43),
    errors,
  };
}

export interface AccessKeyInput {
  /** Sigla (`SP`) ou código do IBGE (`35`). */
  uf: string;
  /** Ano e mês da emissão: `AAAA-MM` ou `AAMM`. */
  issued: string;
  /** CNPJ do emitente, com ou sem pontuação. Aceita alfanumérico. */
  cnpj: string;
  /** 55 NF-e, 65 NFC-e, 57 CT-e, 58 MDF-e. */
  model: string;
  series: string | number;
  number: string | number;
  /** Forma de emissão. Padrão 1 (normal). */
  emissionType?: string | number;
  /** cNF, 8 dígitos. Ausente, é sorteado — é o que a especificação espera dele. */
  randomCode?: string;
}

const pad = (value: string | number, size: number) => String(value).replace(/\D/g, "").padStart(size, "0");

/**
 * Monta a chave a partir dos campos, calculando o dígito verificador.
 *
 * Lança NfeError, que o endpoint traduz em 400: os limites vêm da especificação, não da API.
 */
export function buildAccessKey(input: AccessKeyInput): string {
  const ufCode = CODE_BY_UF[input.uf.trim().toUpperCase()] ?? (UF_BY_CODE[input.uf.trim()] ? input.uf.trim() : null);
  if (!ufCode) throw new NfeError("invalid_uf", "uf deve ser a sigla do estado (SP) ou o código do IBGE (35).");

  const issued = input.issued.replace(/\D/g, "");
  // Aceita AAAAMM e AAMM: quem monta a chave costuma ter a data inteira em mãos.
  const aamm = issued.length === 6 ? issued.slice(2) : issued;
  if (aamm.length !== 4 || Number(aamm.slice(2)) < 1 || Number(aamm.slice(2)) > 12) {
    throw new NfeError("invalid_issued", "issued deve ser AAAA-MM ou AAMM, com mês entre 01 e 12.");
  }

  const cnpj = normalizeCnpj(input.cnpj);
  if (!isValidCnpj(cnpj)) throw new NfeError("invalid_cnpj", "cnpj inválido: confira os dígitos verificadores.");

  const model = pad(input.model, 2);
  if (!/^\d{2}$/.test(model)) throw new NfeError("invalid_model", "model deve ter dois dígitos (55, 65, 57 ou 58).");

  const emissionType = pad(input.emissionType ?? 1, 1);
  if (!/^\d$/.test(emissionType)) throw new NfeError("invalid_emission_type", "emissionType deve ser um dígito.");

  const randomCode = input.randomCode === undefined ? randomNumericCode() : pad(input.randomCode, 8);
  if (!/^\d{8}$/.test(randomCode)) throw new NfeError("invalid_random_code", "randomCode deve ter 8 dígitos.");

  const base43 = ufCode + aamm + cnpj + model + pad(input.series, 3) + pad(input.number, 9) + emissionType + randomCode;
  if (base43.length !== 43) {
    throw new NfeError("invalid_fields", "Algum campo excede o tamanho previsto na chave.");
  }

  return base43 + accessKeyCheckDigit(base43);
}

function randomNumericCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += Math.floor(Math.random() * 10);
  return code;
}
