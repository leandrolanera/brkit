/**
 * Boleto: linha digitável e código de barras.
 *
 * Dois formatos convivem e não compartilham quase nada além do comprimento do código de barras:
 *
 * - Cobrança bancária: código de barras de 44 dígitos, linha digitável de 47 (5 campos).
 *   DV geral por módulo 11; DV dos campos 1 a 3 por módulo 10.
 * - Arrecadação (água, luz, tributos): código de barras de 44, linha digitável de 48
 *   (4 blocos de 11 + 1 DV cada). O módulo do DV depende da 3ª posição do código.
 *
 * Referências conferidas na implementação: "Layout Padrão de Arrecadação/Recebimento com
 * Utilização do Código de Barras" (FEBRABAN, v7) para a arrecadação e para os algoritmos de
 * módulo 10 e 11, e um par código de barras/linha digitável de cobrança para o caminho da
 * cobrança. Os vetores estão nos testes.
 *
 * Atenção a uma diferença fácil de passar batida: o módulo 11 da arrecadação e o DV geral da
 * cobrança tratam as bordas de formas distintas (ver mod11Arrecadacao e mod11Cobranca).
 */

const DAY_MS = 86_400_000;

/** Data base original do fator de vencimento. */
const FACTOR_EPOCH = Date.UTC(1997, 9, 7);

/**
 * O fator de vencimento tem 4 dígitos e chegou a 9999 em 21/02/2025. A FEBRABAN determinou o
 * reinício em 1000 a partir de 22/02/2025, então todo fator passou a mapear duas datas
 * possíveis, a ~24,6 anos de distância. Ver dueDateFromFactor.
 */
const FACTOR_RESET_DATE = Date.UTC(2025, 1, 22);
const FACTOR_RESET_VALUE = 1000;

/**
 * Nomes dos bancos emissores mais comuns (código COMPE). Tabela deliberadamente parcial: só
 * entram códigos conferidos, e o que não está aqui volta como null em vez de um nome errado.
 */
const BANK_NAMES: Record<string, string> = {
  "001": "Banco do Brasil",
  "003": "Banco da Amazônia",
  "004": "Banco do Nordeste do Brasil",
  "021": "Banestes",
  "033": "Banco Santander (Brasil)",
  "041": "Banrisul",
  "047": "Banese",
  "070": "Banco de Brasília (BRB)",
  "077": "Banco Inter",
  "104": "Caixa Econômica Federal",
  "197": "Stone",
  "208": "Banco BTG Pactual",
  "212": "Banco Original",
  "218": "Banco BS2",
  "237": "Banco Bradesco",
  "246": "Banco ABC Brasil",
  "260": "Nu Pagamentos (Nubank)",
  "290": "PagSeguro (PagBank)",
  "318": "Banco BMG",
  "336": "Banco C6",
  "341": "Itaú Unibanco",
  "380": "PicPay",
  "422": "Banco Safra",
  "623": "Banco Pan",
  "637": "Banco Sofisa",
  "707": "Banco Daycoval",
  "745": "Banco Citibank",
  "748": "Sicredi",
  "752": "BNP Paribas Brasil",
  "756": "Sicoob",
};

/** Segmentos da arrecadação (2ª posição do código de barras). */
const SEGMENTS: Record<string, string> = {
  "1": "Prefeituras",
  "2": "Saneamento",
  "3": "Energia elétrica e gás",
  "4": "Telecomunicações",
  "5": "Órgãos governamentais",
  "6": "Carnês e demais empresas",
  "7": "Multas de trânsito",
  "9": "Uso exclusivo do banco",
};

/**
 * Módulo 10 (FEBRABAN): multiplicadores 2, 1, 2, 1... da direita para a esquerda, somando os
 * ALGARISMOS de cada produto (12 entra como 1 + 2). DV = 10 − resto, e 0 quando o resto é 0.
 */
export function mod10(seq: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = seq.length - 1; i >= 0; i--) {
    const product = Number(seq[i]) * weight;
    sum += product > 9 ? Math.floor(product / 10) + (product % 10) : product;
    weight = weight === 2 ? 1 : 2;
  }
  const rest = sum % 10;
  return rest === 0 ? 0 : 10 - rest;
}

/**
 * Módulo 11 da ARRECADAÇÃO: multiplicadores 2..9 ciclando da direita, somando os PRODUTOS.
 * Bordas conforme a FEBRABAN: resto 0 ou 1 → DV 0; resto 10 → DV 1.
 */
export function mod11Arrecadacao(seq: string): number {
  const rest = weightedSum2to9(seq) % 11;
  if (rest === 0 || rest === 1) return 0;
  if (rest === 10) return 1;
  return 11 - rest;
}

/**
 * DV geral da COBRANÇA: mesma soma ponderada, bordas diferentes — resto 0, 1 ou 10 resulta
 * em DV 1. Trocar esta regra pela da arrecadação (ou vice-versa) só aparece em alguns códigos,
 * o que torna o erro especialmente silencioso.
 */
export function mod11Cobranca(seq: string): number {
  const dv = 11 - (weightedSum2to9(seq) % 11);
  return dv === 0 || dv > 9 ? 1 : dv;
}

function weightedSum2to9(seq: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = seq.length - 1; i >= 0; i--) {
    sum += Number(seq[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  return sum;
}

export interface DueDates {
  /** Interpretação escolhida: a data mais próxima de hoje entre as duas possíveis. */
  due_date: string | null;
  /** Fator lido no ciclo iniciado em 22/02/2025. */
  due_date_current_cycle: string | null;
  /** Fator lido na contagem original, a partir de 07/10/1997. */
  due_date_legacy_cycle: string | null;
  /** true quando as duas leituras são possíveis e só o contexto decide. */
  due_date_ambiguous: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Converte o fator de vencimento em data.
 *
 * Depois do reinício de 22/02/2025 o fator é ambíguo: 1601, por exemplo, pode ser 18/02/2002
 * (contagem original) ou 15/10/2026 (ciclo novo). Como não há nada no código de barras que
 * diferencie, devolvemos as duas leituras e elegemos a mais próxima de hoje — que acerta tanto
 * o boleto corrente quanto o bem atrasado, emitido antes da virada.
 *
 * Fator 0000 significa "sem vencimento" (contra apresentação).
 */
export function dueDateFromFactor(factor: number, now = new Date()): DueDates {
  if (factor === 0) {
    return {
      due_date: null,
      due_date_current_cycle: null,
      due_date_legacy_cycle: null,
      due_date_ambiguous: false,
    };
  }

  const legacy = FACTOR_EPOCH + factor * DAY_MS;
  const current = FACTOR_RESET_DATE + (factor - FACTOR_RESET_VALUE) * DAY_MS;
  const reference = now.getTime();

  // Abaixo de 1000 só a contagem original existe: o reinício se deu exatamente em 1000, então
  // o ciclo novo nunca produz fator menor que isso.
  if (factor < FACTOR_RESET_VALUE) {
    return {
      due_date: iso(legacy),
      due_date_current_cycle: null,
      due_date_legacy_cycle: iso(legacy),
      due_date_ambiguous: false,
    };
  }

  const chosen = Math.abs(current - reference) <= Math.abs(legacy - reference) ? current : legacy;
  return {
    due_date: iso(chosen),
    due_date_current_cycle: iso(current),
    due_date_legacy_cycle: iso(legacy),
    due_date_ambiguous: true,
  };
}

export type BoletoKind = "cobranca" | "arrecadacao";

interface BoletoCommon {
  valid: boolean;
  kind: BoletoKind;
  /** Código de barras de 44 dígitos. */
  barcode: string;
  /** Linha digitável: 47 dígitos na cobrança, 48 na arrecadação. */
  digitable_line: string;
  /** Valor em reais, ou null quando o campo está zerado. */
  amount: number | null;
  /** Motivos de `valid: false`. Vazio quando o código confere. */
  errors: string[];
}

export interface CobrancaBoleto extends BoletoCommon, DueDates {
  kind: "cobranca";
  bank_code: string;
  bank_name: string | null;
  currency_code: string;
  due_factor: number;
  free_field: string;
}

export interface ArrecadacaoBoleto extends BoletoCommon {
  kind: "arrecadacao";
  segment: string;
  segment_name: string | null;
  /** "efetivo" = valor em reais; "referencia" = quantidade de moeda ou valor a reajustar. */
  value_kind: "efetivo" | "referencia";
  /** Módulo usado nos DVs, determinado pela 3ª posição do código. */
  checksum: "mod10" | "mod11";
  /** Posições 16 a 19: identificação da empresa/órgão. */
  company_id: string;
  free_field: string;
  /**
   * Vencimento quando a empresa usa as 8 primeiras posições do campo livre como AAAAMMDD,
   * que a FEBRABAN prevê mas não obriga. null quando ali não há uma data plausível.
   */
  due_date: string | null;
}

export type DecodedBoleto = CobrancaBoleto | ArrecadacaoBoleto;

const digitsOnly = (input: string) => input.replace(/\D/g, "");

/** Valor em centavos → reais. Campo zerado vira null: não é "R$ 0,00", é "sem valor". */
function parseAmount(raw: string): number | null {
  const cents = Number(raw);
  return Number.isFinite(cents) && cents > 0 ? cents / 100 : null;
}

// ---------------------------------------------------------------------------
// Cobrança bancária

/** Campos do código de barras de cobrança (44): banco(3) moeda(1) DV(1) fator(4) valor(10) livre(25). */
function cobrancaFields(barcode: string) {
  return {
    bank: barcode.slice(0, 3),
    currency: barcode.slice(3, 4),
    dv: barcode.slice(4, 5),
    factor: barcode.slice(5, 9),
    amount: barcode.slice(9, 19),
    free: barcode.slice(19, 44),
  };
}

/** DV geral: módulo 11 sobre as 43 posições, pulando a 5ª (o próprio DV). */
function cobrancaGeneralDv(barcode: string): number {
  return mod11Cobranca(barcode.slice(0, 4) + barcode.slice(5));
}

export function cobrancaBarcodeToLine(barcode: string): string {
  const f = cobrancaFields(barcode);
  const field1 = f.bank + f.currency + f.free.slice(0, 5);
  const field2 = f.free.slice(5, 15);
  const field3 = f.free.slice(15, 25);
  return (
    `${field1}${mod10(field1)}` +
    `${field2}${mod10(field2)}` +
    `${field3}${mod10(field3)}` +
    f.dv +
    f.factor +
    f.amount
  );
}

/** Remonta o código de barras a partir da linha digitável, descartando os DVs de campo. */
export function cobrancaLineToBarcode(line: string): string {
  return (
    line.slice(0, 4) + // banco + moeda
    line.slice(32, 33) + // DV geral
    line.slice(33, 47) + // fator + valor
    line.slice(4, 9) + // resto do campo 1
    line.slice(10, 20) + // campo 2
    line.slice(21, 31) // campo 3
  );
}

// ---------------------------------------------------------------------------
// Arrecadação

/** A 3ª posição define o módulo dos DVs e se o valor é efetivo ou referência. */
function arrecadacaoValueCode(barcode: string): { checksum: "mod10" | "mod11"; value_kind: "efetivo" | "referencia" } | null {
  switch (barcode[2]) {
    case "6":
      return { checksum: "mod10", value_kind: "efetivo" };
    case "7":
      return { checksum: "mod10", value_kind: "referencia" };
    case "8":
      return { checksum: "mod11", value_kind: "efetivo" };
    case "9":
      return { checksum: "mod11", value_kind: "referencia" };
    default:
      return null;
  }
}

const arrecadacaoDv = (checksum: "mod10" | "mod11", seq: string) =>
  checksum === "mod10" ? mod10(seq) : mod11Arrecadacao(seq);

/** DV geral: sobre as 43 posições, pulando a 4ª (o próprio DV). */
function arrecadacaoGeneralDv(barcode: string, checksum: "mod10" | "mod11"): number {
  return arrecadacaoDv(checksum, barcode.slice(0, 3) + barcode.slice(4));
}

export function arrecadacaoBarcodeToLine(barcode: string, checksum: "mod10" | "mod11"): string {
  let line = "";
  for (let i = 0; i < 4; i++) {
    const block = barcode.slice(i * 11, i * 11 + 11);
    line += `${block}${arrecadacaoDv(checksum, block)}`;
  }
  return line;
}

export function arrecadacaoLineToBarcode(line: string): string {
  let barcode = "";
  for (let i = 0; i < 4; i++) barcode += line.slice(i * 12, i * 12 + 11);
  return barcode;
}

/** Vencimento opcional nas 8 primeiras posições do campo livre, no formato AAAAMMDD. */
function arrecadacaoDueDate(free: string): string | null {
  const raw = free.slice(0, 8);
  if (!/^\d{8}$/.test(raw)) return null;
  const [year, month, day] = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8)];
  const date = `${year}-${month}-${day}`;
  const ms = Date.parse(`${date}T00:00:00Z`);
  // Só aceita o que for data de verdade e plausível: o campo livre costuma ser outra coisa.
  if (Number.isNaN(ms) || iso(ms) !== date) return null;
  const y = Number(year);
  return y >= 1997 && y <= 2100 ? date : null;
}

// ---------------------------------------------------------------------------
// Decodificação

function decodeCobranca(barcode: string, inputLine: string | null, now: Date): CobrancaBoleto {
  const errors: string[] = [];
  const f = cobrancaFields(barcode);

  const expectedDv = cobrancaGeneralDv(barcode);
  if (Number(f.dv) !== expectedDv) errors.push("invalid_general_check_digit");

  // Só faz sentido conferir os DVs de campo quando eles vieram na entrada: gerados a partir
  // do código de barras, eles são corretos por construção.
  const line = cobrancaBarcodeToLine(barcode);
  if (inputLine && inputLine !== line) errors.push("invalid_field_check_digit");

  if (f.currency !== "9") errors.push("unexpected_currency_code");

  const factor = Number(f.factor);
  return {
    valid: errors.length === 0,
    kind: "cobranca",
    barcode,
    digitable_line: line,
    bank_code: f.bank,
    bank_name: BANK_NAMES[f.bank] ?? null,
    currency_code: f.currency,
    amount: parseAmount(f.amount),
    due_factor: factor,
    free_field: f.free,
    ...dueDateFromFactor(factor, now),
    errors,
  };
}

function decodeArrecadacao(barcode: string, inputLine: string | null): ArrecadacaoBoleto | null {
  const code = arrecadacaoValueCode(barcode);
  // Sem um identificador de valor conhecido não há como saber o módulo dos DVs, então nem
  // dá para dizer que o código é inválido: ele simplesmente não é desta especificação.
  if (!code) return null;

  const errors: string[] = [];
  const expectedDv = arrecadacaoGeneralDv(barcode, code.checksum);
  if (Number(barcode[3]) !== expectedDv) errors.push("invalid_general_check_digit");

  const line = arrecadacaoBarcodeToLine(barcode, code.checksum);
  if (inputLine && inputLine !== line) errors.push("invalid_block_check_digit");

  const segment = barcode.slice(1, 2);
  const free = barcode.slice(19, 44);
  return {
    valid: errors.length === 0,
    kind: "arrecadacao",
    barcode,
    digitable_line: line,
    segment,
    segment_name: SEGMENTS[segment] ?? null,
    value_kind: code.value_kind,
    checksum: code.checksum,
    // Referência não carrega reais, então não faz sentido apresentar como valor.
    amount: code.value_kind === "efetivo" ? parseAmount(barcode.slice(4, 15)) : null,
    company_id: barcode.slice(15, 19),
    free_field: free,
    due_date: arrecadacaoDueDate(free),
    errors,
  };
}

/**
 * Decodifica uma linha digitável (47 ou 48 dígitos) ou um código de barras (44), identificando
 * o formato sozinho. Pontuação e espaços são ignorados.
 *
 * Devolve null quando a entrada não tem um comprimento compatível com nenhum dos formatos.
 * Comprimento certo e DV errado volta com `valid: false` e `errors` preenchido, junto com os
 * campos que deram para ler — quem está conferindo um código digitado errado precisa ver isso.
 */
export function decodeBoleto(input: string, now = new Date()): DecodedBoleto | null {
  const digits = digitsOnly(input);

  if (digits.length === 47) return decodeCobranca(cobrancaLineToBarcode(digits), digits, now);
  if (digits.length === 48) return decodeArrecadacao(arrecadacaoLineToBarcode(digits), digits);
  if (digits.length !== 44) return null;

  // Código de barras: o "8" inicial indica arrecadação, mas existem bancos com código 8xx
  // (851, por exemplo), então a leitura não é decidida só pelo primeiro dígito. Tenta as duas
  // e fica com a que fecha os DVs; se nenhuma fechar, devolve a indicada pelo primeiro dígito.
  const asArrecadacao = () => decodeArrecadacao(digits, null);
  const asCobranca = () => decodeCobranca(digits, null, now);

  const primary = digits.startsWith("8") ? asArrecadacao() : asCobranca();
  if (primary?.valid) return primary;

  const fallback = digits.startsWith("8") ? asCobranca() : asArrecadacao();
  if (fallback?.valid) return fallback;

  return primary ?? fallback;
}
