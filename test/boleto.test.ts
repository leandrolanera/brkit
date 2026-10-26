import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import {
  arrecadacaoBarcodeToLine,
  cobrancaBarcodeToLine,
  cobrancaLineToBarcode,
  decodeBoleto,
  dueDateFromFactor,
  mod10,
  mod11Arrecadacao,
  mod11Cobranca,
} from "../lib/boleto.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as boletoDecode } from "../handlers/v1/boleto/decode.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

/**
 * Vetores de fora desta implementação — é o que dá valor a estes testes.
 *
 * FEBRABAN_* vêm do "Layout Padrão de Arrecadação/Recebimento com Utilização do Código de
 * Barras" (v7). COBRANCA_* é um par código de barras/linha digitável de cobrança publicado
 * por terceiro. Os dois exemplos de 44 dígitos da FEBRABAN usam "2" na 3ª posição, fora do
 * conjunto 6-9 da especificação atual: são demonstrações do algoritmo, não códigos conformes,
 * e por isso só servem para checar os módulos, nunca o decodificador.
 */
const FEBRABAN_SEQ = "01230067896";
const FEBRABAN_MOD10_EXAMPLE = "82210000215048200974123220154098290108605940";
const FEBRABAN_MOD11_EXAMPLE = "82200000215048200974123220154098290108605940";

const COBRANCA_BARCODE = "00193373700000001000500940144816060680935031";
const COBRANCA_LINE = "00190500954014481606906809350314337370000000100";

/**
 * As 43 posições do cálculo do DV: tudo menos o próprio DV. A posição dele difere entre os
 * formatos — 4ª na arrecadação, 5ª na cobrança — então são dois helpers, não um.
 */
const calcBaseArrecadacao = (barcode44: string) => barcode44.slice(0, 3) + barcode44.slice(4);
const calcBaseCobranca = (barcode44: string) => barcode44.slice(0, 4) + barcode44.slice(5);

/**
 * Monta um código de arrecadação válido, com o DV geral calculado.
 * `body` já são as 43 posições do cálculo: 3 iniciais + valor(11) + empresa(4) + livre(25).
 */
function arrecadacao(
  valueCode: "6" | "7" | "8" | "9",
  opts: { segment?: string; value?: string; free?: string } = {},
) {
  const segment = opts.segment ?? "3";
  const value = (opts.value ?? "00000015000").padStart(11, "0");
  const free = (opts.free ?? "2026101512345678901234567").padEnd(25, "0").slice(0, 25);
  const body = `8${segment}${valueCode}${value}1234${free}`;
  const checksum = valueCode === "6" || valueCode === "7" ? "mod10" : "mod11";
  const dv = checksum === "mod10" ? mod10(body) : mod11Arrecadacao(body);
  const barcode = body.slice(0, 3) + dv + body.slice(3);
  return { barcode, line: arrecadacaoBarcodeToLine(barcode, checksum), checksum };
}

/** Recalcula o DV geral de um código de cobrança alterado, para o teste partir de um válido. */
const fixCobrancaDv = (barcode: string) =>
  barcode.slice(0, 4) + String(mod11Cobranca(calcBaseCobranca(barcode))) + barcode.slice(5);

describe("módulo 10 e módulo 11", () => {
  test("módulo 10 reproduz o exemplo resolvido da FEBRABAN", () => {
    assert.equal(mod10(FEBRABAN_SEQ), 3);
  });

  test("módulo 11 da arrecadação reproduz o exemplo resolvido da FEBRABAN", () => {
    assert.equal(mod11Arrecadacao(FEBRABAN_SEQ), 0);
  });

  test("módulo 10 sobre as 43 posições do exemplo completo", () => {
    assert.equal(mod10(calcBaseArrecadacao(FEBRABAN_MOD10_EXAMPLE)), 1);
    // O DV calculado tem de bater com o que o exemplo já traz na 4ª posição.
    assert.equal(mod10(calcBaseArrecadacao(FEBRABAN_MOD10_EXAMPLE)), Number(FEBRABAN_MOD10_EXAMPLE[3]));
  });

  test("módulo 11 sobre as 43 posições do exemplo completo", () => {
    assert.equal(mod11Arrecadacao(calcBaseArrecadacao(FEBRABAN_MOD11_EXAMPLE)), 0);
    assert.equal(mod11Arrecadacao(calcBaseArrecadacao(FEBRABAN_MOD11_EXAMPLE)), Number(FEBRABAN_MOD11_EXAMPLE[3]));
  });

  test("módulo 10 soma os algarismos do produto, não o produto", () => {
    // "5" * 2 = 10, que entra como 1 + 0. Somar 10 daria outro DV.
    assert.equal(mod10("5"), 9);
  });

  /**
   * As duas variantes de módulo 11 só divergem nas bordas, e um código comum não as alcança —
   * é por isso que trocar uma regra pela outra passa quase calado. Estas sequências caem
   * exatamente em resto 0, 1 e 10 (mesma soma ponderada, pesos 2..9 da direita) e fixam a
   * diferença: na arrecadação resto 0 ou 1 dá DV 0; na cobrança, DV 1.
   */
  const EDGE_CASES = [
    { seq: "00000000000", rest: 0, arrecadacao: 0, cobranca: 1 },
    { seq: "00000000006", rest: 1, arrecadacao: 0, cobranca: 1 },
    { seq: "00000000005", rest: 10, arrecadacao: 1, cobranca: 1 },
  ];

  test("bordas do módulo 11 da arrecadação: resto 0 ou 1 dá DV 0, resto 10 dá DV 1", () => {
    for (const c of EDGE_CASES) {
      assert.equal(mod11Arrecadacao(c.seq), c.arrecadacao, `resto ${c.rest}`);
    }
  });

  test("bordas do DV geral da cobrança: resto 0, 1 ou 10 dá DV 1", () => {
    for (const c of EDGE_CASES) {
      assert.equal(mod11Cobranca(c.seq), c.cobranca, `resto ${c.rest}`);
    }
  });

  test("as duas variantes divergem justamente nas bordas", () => {
    const diverge = EDGE_CASES.filter((c) => c.arrecadacao !== c.cobranca);
    assert.equal(diverge.length, 2, "resto 0 e resto 1 precisam divergir");
    assert.deepEqual(diverge.map((c) => c.rest), [0, 1]);
  });

  test("o DV sempre cabe em um dígito", () => {
    for (let i = 0; i < 500; i++) {
      const seq = String(i * 7919).padStart(11, "0").slice(-11);
      for (const dv of [mod10(seq), mod11Arrecadacao(seq), mod11Cobranca(seq)]) {
        assert.ok(dv >= 0 && dv <= 9, `DV fora da faixa para ${seq}: ${dv}`);
      }
    }
  });
});

describe("cobrança: conversão entre código de barras e linha digitável", () => {
  test("monta a linha digitável publicada a partir do código de barras", () => {
    assert.equal(cobrancaBarcodeToLine(COBRANCA_BARCODE), COBRANCA_LINE);
  });

  test("remonta o código de barras a partir da linha digitável", () => {
    assert.equal(cobrancaLineToBarcode(COBRANCA_LINE), COBRANCA_BARCODE);
  });

  test("o DV geral do exemplo confere", () => {
    assert.equal(mod11Cobranca(calcBaseCobranca(COBRANCA_BARCODE)), Number(COBRANCA_BARCODE[4]));
  });
});

describe("decodeBoleto: cobrança", () => {
  test("decodifica a linha digitável do exemplo", () => {
    const d = decodeBoleto(COBRANCA_LINE);
    assert.ok(d);
    assert.equal(d.kind, "cobranca");
    assert.equal(d.valid, true);
    assert.deepEqual(d.errors, []);
    assert.equal(d.barcode, COBRANCA_BARCODE);
    if (d.kind !== "cobranca") return;
    assert.equal(d.bank_code, "001");
    assert.equal(d.bank_name, "Banco do Brasil");
    assert.equal(d.currency_code, "9");
    assert.equal(d.amount, 1);
    assert.equal(d.due_factor, 3737);
    assert.equal(d.free_field.length, 25);
  });

  test("o código de barras como entrada dá o mesmo resultado da linha digitável", () => {
    const fromLine = decodeBoleto(COBRANCA_LINE);
    const fromBarcode = decodeBoleto(COBRANCA_BARCODE);
    assert.deepEqual(fromBarcode, fromLine);
  });

  test("ignora pontuação e espaços", () => {
    const d = decodeBoleto("00190.50095 40144.816069 06809.350314 3 37370000000100");
    assert.equal(d?.valid, true);
    assert.equal(d?.barcode, COBRANCA_BARCODE);
  });

  test("DV geral errado é apontado, e os campos continuam legíveis", () => {
    // Troca o DV geral (posição 33 da linha digitável) por outro dígito.
    const dv = COBRANCA_LINE[32];
    const outro = dv === "9" ? "8" : String(Number(dv) + 1);
    const d = decodeBoleto(COBRANCA_LINE.slice(0, 32) + outro + COBRANCA_LINE.slice(33));
    assert.ok(d);
    assert.equal(d.valid, false);
    assert.ok(d.errors.includes("invalid_general_check_digit"));
    if (d.kind === "cobranca") assert.equal(d.bank_code, "001", "quem digitou errado precisa ver o resto");
  });

  test("DV de campo errado é apontado", () => {
    // Posição 10 da linha digitável é o DV do campo 1.
    const dv = COBRANCA_LINE[9];
    const outro = dv === "9" ? "8" : String(Number(dv) + 1);
    const d = decodeBoleto(COBRANCA_LINE.slice(0, 9) + outro + COBRANCA_LINE.slice(10));
    assert.ok(d);
    assert.equal(d.valid, false);
    assert.ok(d.errors.includes("invalid_field_check_digit"));
  });

  test("banco fora da tabela devolve null no nome, não um nome errado", () => {
    const barcode = "999" + COBRANCA_BARCODE.slice(3);
    const d = decodeBoleto(fixCobrancaDv(barcode));
    assert.equal(d?.valid, true);
    if (d?.kind === "cobranca") {
      assert.equal(d.bank_code, "999");
      assert.equal(d.bank_name, null);
    }
  });

  test("valor zerado vira null, não R$ 0,00", () => {
    const barcode = COBRANCA_BARCODE.slice(0, 9) + "0".repeat(10) + COBRANCA_BARCODE.slice(19);
    assert.equal(decodeBoleto(fixCobrancaDv(barcode))?.amount, null);
  });
});

describe("fator de vencimento", () => {
  const hoje = new Date("2026-10-15T12:00:00Z");

  test("fator do ciclo atual resolve para a data de hoje", () => {
    // 22/02/2025 é o fator 1000; 1600 dias depois cai em 15/10/2026.
    const d = dueDateFromFactor(1600, hoje);
    assert.equal(d.due_date, "2026-10-15");
    assert.equal(d.due_date_current_cycle, "2026-10-15");
  });

  test("o reinício de 2025 é respeitado: 1000 é 22/02/2025", () => {
    assert.equal(dueDateFromFactor(1000, hoje).due_date_current_cycle, "2025-02-22");
  });

  test("a contagem original mantém 1000 em 03/07/2000", () => {
    assert.equal(dueDateFromFactor(1000, hoje).due_date_legacy_cycle, "2000-07-03");
  });

  test("fator alto é lido na contagem original: boleto vencido antes da virada", () => {
    // 9999 foi 21/02/2025; no ciclo novo cairia em 2049, implausível.
    const d = dueDateFromFactor(9999, hoje);
    assert.equal(d.due_date, "2025-02-21");
    assert.equal(d.due_date_legacy_cycle, "2025-02-21");
    assert.equal(d.due_date_ambiguous, true);
  });

  test("abaixo de 1000 não há ambiguidade: o ciclo novo começa em 1000", () => {
    const d = dueDateFromFactor(999, hoje);
    assert.equal(d.due_date_current_cycle, null);
    assert.equal(d.due_date_ambiguous, false);
    assert.equal(d.due_date, "2000-07-02");
  });

  test("fator 0000 significa sem vencimento", () => {
    const d = dueDateFromFactor(0, hoje);
    assert.equal(d.due_date, null);
    assert.equal(d.due_date_ambiguous, false);
  });

  test("as duas leituras ficam sempre expostas quando o fator é ambíguo", () => {
    const d = dueDateFromFactor(5000, hoje);
    assert.ok(d.due_date_current_cycle);
    assert.ok(d.due_date_legacy_cycle);
    assert.notEqual(d.due_date_current_cycle, d.due_date_legacy_cycle);
    assert.ok(d.due_date === d.due_date_current_cycle || d.due_date === d.due_date_legacy_cycle);
  });
});

describe("decodeBoleto: arrecadação", () => {
  test("decodifica a linha digitável de 48 dígitos", () => {
    const { barcode, line } = arrecadacao("8");
    assert.equal(line.length, 48);
    const d = decodeBoleto(line);
    assert.ok(d);
    assert.equal(d.kind, "arrecadacao");
    assert.equal(d.valid, true);
    assert.deepEqual(d.errors, []);
    assert.equal(d.barcode, barcode);
    if (d.kind !== "arrecadacao") return;
    assert.equal(d.segment, "3");
    assert.equal(d.segment_name, "Energia elétrica e gás");
    assert.equal(d.amount, 150);
    assert.equal(d.company_id, "1234");
  });

  test("o código de barras de 44 dígitos leva ao mesmo resultado", () => {
    const { barcode, line } = arrecadacao("8");
    const d = decodeBoleto(barcode);
    assert.equal(d?.valid, true);
    assert.equal(d?.digitable_line, line);
  });

  test("a 3ª posição decide o módulo dos DVs", () => {
    for (const [valueCode, expected] of [["6", "mod10"], ["7", "mod10"], ["8", "mod11"], ["9", "mod11"]] as const) {
      const { line } = arrecadacao(valueCode);
      const d = decodeBoleto(line);
      assert.equal(d?.valid, true, `falhou para a 3ª posição = ${valueCode}`);
      if (d?.kind === "arrecadacao") assert.equal(d.checksum, expected);
    }
  });

  test("referência não apresenta valor em reais", () => {
    const efetivo = decodeBoleto(arrecadacao("8").line);
    const referencia = decodeBoleto(arrecadacao("9").line);
    if (efetivo?.kind === "arrecadacao") assert.equal(efetivo.amount, 150);
    if (referencia?.kind === "arrecadacao") {
      assert.equal(referencia.value_kind, "referencia");
      assert.equal(referencia.amount, null, "quantidade de moeda não é valor em reais");
    }
  });

  test("lê o vencimento quando o campo livre começa com AAAAMMDD", () => {
    const d = decodeBoleto(arrecadacao("8", { free: "20261120".padEnd(25, "7") }).line);
    if (d?.kind === "arrecadacao") assert.equal(d.due_date, "2026-11-20");
  });

  test("campo livre que não é data devolve vencimento null", () => {
    const d = decodeBoleto(arrecadacao("8", { free: "99999999".padEnd(25, "1") }).line);
    if (d?.kind === "arrecadacao") assert.equal(d.due_date, null);
  });

  test("DV de bloco errado é apontado", () => {
    const { line } = arrecadacao("8");
    const dv = line[11];
    const outro = dv === "9" ? "8" : String(Number(dv) + 1);
    const d = decodeBoleto(line.slice(0, 11) + outro + line.slice(12));
    assert.equal(d?.valid, false);
    assert.ok(d?.errors.includes("invalid_block_check_digit"));
  });

  test("segmento desconhecido devolve null no nome", () => {
    const d = decodeBoleto(arrecadacao("8", { segment: "8" }).line);
    if (d?.kind === "arrecadacao") assert.equal(d.segment_name, null);
  });
});

describe("decodeBoleto: identificação do formato", () => {
  test("47 dígitos é cobrança, 48 é arrecadação", () => {
    assert.equal(decodeBoleto(COBRANCA_LINE)?.kind, "cobranca");
    assert.equal(decodeBoleto(arrecadacao("8").line)?.kind, "arrecadacao");
  });

  test("código de barras de 44 começando com 8 é lido como arrecadação", () => {
    assert.equal(decodeBoleto(arrecadacao("6").barcode)?.kind, "arrecadacao");
    assert.equal(decodeBoleto(arrecadacao("8").barcode)?.kind, "arrecadacao");
  });

  test("8 inicial com 3ª posição fora de 6-9 não é arrecadação", () => {
    // Sem identificador de valor conhecido não há como saber o módulo do DV.
    const d = decodeBoleto("8" + "2" + "0" + "0".repeat(41));
    assert.equal(d?.kind, "cobranca", "cai para a leitura de cobrança");
  });

  test("banco com código 8xx não é confundido com arrecadação", () => {
    // 851 é um código COMPE real: só o primeiro dígito não decide o formato.
    const barcode = "851" + COBRANCA_BARCODE.slice(3);
    const d = decodeBoleto(fixCobrancaDv(barcode));
    assert.equal(d?.kind, "cobranca", "a validação do DV precisa desempatar");
    assert.equal(d?.valid, true);
    if (d?.kind === "cobranca") assert.equal(d.bank_code, "851");
  });

  test("comprimento incompatível devolve null", () => {
    for (const bad of ["", "123", "1".repeat(43), "1".repeat(45), "1".repeat(46), "1".repeat(49)]) {
      assert.equal(decodeBoleto(bad), null, `deveria recusar ${bad.length} dígitos`);
    }
  });

  test("o campo moeda diferente de 9 é sinalizado na cobrança", () => {
    const barcode = COBRANCA_BARCODE.slice(0, 3) + "8" + COBRANCA_BARCODE.slice(4);
    const d = decodeBoleto(fixCobrancaDv(barcode));
    assert.ok(d?.errors.includes("unexpected_currency_code"));
  });
});

describe("POST /v1/boleto/decode", () => {
  test("decodifica a linha digitável e devolve as duas representações", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(boletoDecode, "/v1/boleto/decode", key, jsonBody({ code: COBRANCA_LINE }));
    assert.equal(res.status, 200);
    const out = (await res.json()) as Record<string, unknown>;
    assert.equal(out.valid, true);
    assert.equal(out.kind, "cobranca");
    assert.equal(out.barcode, COBRANCA_BARCODE);
    assert.equal(out.digitable_line, COBRANCA_LINE);
    assert.equal(out.bank_name, "Banco do Brasil");
  });

  test("serve de conversor: código de barras entra, linha digitável sai", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(boletoDecode, "/v1/boleto/decode", key, jsonBody({ code: COBRANCA_BARCODE }));
    assert.equal(((await res.json()) as { digitable_line: string }).digitable_line, COBRANCA_LINE);
  });

  test("DV errado é 200 com valid: false, não erro", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const quebrado = `${COBRANCA_LINE.slice(0, 46)}${COBRANCA_LINE[46] === "9" ? "8" : "9"}`;
    const res = await call(boletoDecode, "/v1/boleto/decode", key, jsonBody({ code: quebrado }));
    assert.equal(res.status, 200);
    const out = (await res.json()) as { valid: boolean; errors: string[] };
    assert.equal(out.valid, false);
    assert.ok(out.errors.length > 0, "precisa dizer o que está errado");
  });

  test("comprimento incompatível vira 400", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    for (const bad of [{}, { code: "" }, { code: "123" }, { code: "1".repeat(129) }]) {
      const res = await call(boletoDecode, "/v1/boleto/decode", key, jsonBody(bad));
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });

  test("exige chave de API", async () => {
    assert.equal((await call(boletoDecode, "/v1/boleto/decode", undefined, jsonBody({ code: COBRANCA_LINE }))).status, 401);
  });

  test("erro de validação não consome a cota", async () => {
    const { key } = await createApiKey(store, "teste", "free");
    await call(boletoDecode, "/v1/boleto/decode", key, jsonBody({ code: "123" }));
    const ok = await call(boletoDecode, "/v1/boleto/decode", key, jsonBody({ code: COBRANCA_LINE }));
    assert.equal(ok.headers.get("x-usage-remaining"), "999");
  });
});
