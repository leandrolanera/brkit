import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import {
  arrecadacaoBarcodeToLine,
  cobrancaBarcodeToLine,
  decodeBoleto,
  mod11Arrecadacao,
  mod11Cobranca,
} from "../lib/boleto.js";
import { decodePayment } from "../lib/payments.js";
import { buildBrCode, parseBrCode } from "../lib/pix.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as paymentsDecode } from "../api/v1/payments/decode.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

/** Pix gerado pelo próprio código, como nas demais suítes: o fixture não pode estar errado. */
const PIX = buildBrCode({
  key: "contato@exemplo.com.br",
  name: "Livraria Sao Jorge",
  city: "Sao Paulo",
  amount: 89.9,
  txid: "PEDIDO4471",
});

/** Boleto de cobrança válido, montado com os DVs calculados. */
const BOLETO = (() => {
  const livre = "0000000012345678901234567".slice(0, 25);
  const semDv = `0019X16360000124790${livre}`;
  const dv = mod11Cobranca(semDv.slice(0, 4) + semDv.slice(5));
  const barcode = `0019${dv}16360000124790${livre}`;
  return { barcode, line: cobrancaBarcodeToLine(barcode) };
})();

/** Arrecadação válida (3ª posição = 8, logo módulo 11). */
const ARRECADACAO = (() => {
  const body = `838${"00000015000"}1234${"2026112012345678901234567".slice(0, 25)}`;
  // O módulo 11 da arrecadação tem bordas próprias (resto 0 ou 1 dá DV 0).
  const dv = mod11Arrecadacao(body);
  const barcode = body.slice(0, 3) + dv + body.slice(3);
  return { barcode, line: arrecadacaoBarcodeToLine(barcode, "mod11") };
})();

describe("decodePayment: identificação do formato", () => {
  test("reconhece Pix copia e cola", () => {
    const d = decodePayment(PIX);
    assert.equal(d?.kind, "pix");
    assert.equal(d?.valid, true);
    assert.deepEqual(d?.errors, []);
  });

  test("reconhece linha digitável de cobrança", () => {
    const d = decodePayment(BOLETO.line);
    assert.equal(d?.kind, "boleto_cobranca");
    assert.equal(d?.valid, true);
  });

  test("reconhece código de barras de cobrança", () => {
    assert.equal(decodePayment(BOLETO.barcode)?.kind, "boleto_cobranca");
  });

  test("reconhece arrecadação, que tem outro envelope", () => {
    const d = decodePayment(ARRECADACAO.line);
    assert.equal(d?.kind, "boleto_arrecadacao");
    assert.equal(d?.valid, true);
  });

  test("ignora a pontuação que o usuário cola junto", () => {
    const comPontos = `${BOLETO.line.slice(0, 5)}.${BOLETO.line.slice(5, 10)} ${BOLETO.line.slice(10)}`;
    const d = decodePayment(comPontos);
    assert.equal(d?.kind, "boleto_cobranca");
    assert.equal(d?.valid, true);
  });

  test("ignora espaço e quebra de linha em volta", () => {
    assert.equal(decodePayment(`\n  ${PIX}  \n`)?.kind, "pix");
  });

  test("as letras separam os formatos de forma determinística", () => {
    // O GUI br.gov.bcb.pix é obrigatório no BR Code, então todo Pix tem letras.
    // Linha digitável e código de barras são só dígitos e pontuação.
    assert.match(PIX, /[A-Za-z]/);
    assert.doesNotMatch(BOLETO.line, /[A-Za-z]/);
    assert.doesNotMatch(ARRECADACAO.line, /[A-Za-z]/);
  });

  test("Pix inteiro nunca colide: tem mais dígitos do que qualquer boleto", () => {
    // O mínimo é 75 dígitos, acima dos 44/47/48. Esta é a razão de um Pix COMPLETO
    // jamais ser confundido — e não o corte pelas letras.
    const minimo = buildBrCode({ key: "52998224725", name: "A", city: "SP" });
    assert.ok(minimo.replace(/\D/g, "").length > 48);
  });

  test("Pix colado pela metade continua sendo Pix, não vira boleto", () => {
    // Este é o caso que justifica o corte pelas letras: truncado em 80 caracteres, o BR Code
    // fica com exatamente 44 dígitos e o decodificador de boleto o aceitaria como cobrança
    // malformada — mandando conferir dígito verificador num código que nem é boleto.
    const pedaco = PIX.slice(0, 80);
    assert.equal(pedaco.replace(/\D/g, "").length, 44, "o fixture precisa continuar caindo no comprimento de boleto");
    assert.equal(decodeBoleto(pedaco)?.kind, "cobranca", "sem o corte, seria lido como boleto");

    // O TLV truncado não monta envelope nenhum, então o honesto é recusar: "não reconheço".
    // O que importa é NÃO dizer que é boleto, mandando conferir dígito verificador à toa.
    assert.equal(decodePayment(pedaco), null, "melhor recusar do que apontar o formato errado");
  });

  test("espaço em volta não atrapalha", () => {
    // Quem apara é parseBrCode; decodeBoleto descarta não-dígito. O teste fixa o contrato
    // visível, para que mudar os sub-parsers não quebre quem cola com espaço.
    assert.equal(decodePayment(`   ${PIX}   `)?.valid, true);
    assert.equal(decodePayment(`\n ${BOLETO.line} \n`)?.valid, true);
  });
});

describe("decodePayment: envelope comum", () => {
  test("Pix traz valor e beneficiário, e não inventa vencimento", () => {
    const d = decodePayment(PIX);
    assert.equal(d?.amount, 89.9);
    assert.equal(d?.merchant_name, "Livraria Sao Jorge");
    assert.equal(d?.due_date, null, "Pix estático não carrega vencimento");
  });

  test("boleto traz valor e vencimento, e não inventa beneficiário", () => {
    const d = decodePayment(BOLETO.line);
    assert.equal(d?.amount, 1247.9);
    assert.equal(d?.due_date, "2026-11-20");
    assert.equal(d?.merchant_name, null, "o beneficiário vive no campo livre, específico de cada banco");
  });

  test("o envelope tem a mesma forma nos dois formatos", () => {
    const campos = (v: unknown) => Object.keys(v as object).sort();
    assert.deepEqual(campos(decodePayment(PIX)), campos(decodePayment(BOLETO.line)));
  });

  test("details traz a decodificação nativa completa", () => {
    const pix = decodePayment(PIX);
    assert.equal((pix?.details as { txid?: string }).txid, "PEDIDO4471");

    const boleto = decodePayment(BOLETO.line);
    assert.equal((boleto?.details as { bank_name?: string }).bank_name, "Banco do Brasil");
    assert.equal((boleto?.details as { barcode?: string }).barcode, BOLETO.barcode);
  });

  test("Pix com CRC errado volta com valid false e os campos legíveis", () => {
    const d = decodePayment(`${PIX.slice(0, -4)}0000`);
    assert.equal(d?.kind, "pix");
    assert.equal(d?.valid, false);
    assert.deepEqual(d?.errors, ["invalid_crc"]);
    assert.equal(d?.merchant_name, "Livraria Sao Jorge", "quem digitou errado precisa ver o resto");
  });

  test("boleto com dígito errado volta com valid false e o motivo", () => {
    const dv = BOLETO.line[32]!;
    const outro = dv === "9" ? "8" : String(Number(dv) + 1);
    const d = decodePayment(BOLETO.line.slice(0, 32) + outro + BOLETO.line.slice(33));
    assert.equal(d?.valid, false);
    assert.ok(d?.errors.includes("invalid_general_check_digit"));
  });
});

describe("decodePayment: entradas recusadas", () => {
  test("devolve null para o que não é nenhum dos formatos", () => {
    for (const bad of ["", "   ", "oi", "não é código", "1234", "x".repeat(60)]) {
      assert.equal(decodePayment(bad), null, `deveria recusar: ${bad}`);
    }
  });

  test("devolve null para entrada absurdamente longa", () => {
    assert.equal(decodePayment("0".repeat(2000)), null);
  });
});

describe("decodePayment: composição, não reimplementação", () => {
  test("o resultado confere com o das rotas específicas", () => {
    // Se algum dia alguém duplicar a lógica aqui, os dois caminhos divergem e isto quebra.
    assert.deepEqual(decodePayment(PIX)?.details, parseBrCode(PIX));
    assert.deepEqual(decodePayment(BOLETO.line)?.details, decodeBoleto(BOLETO.line));
  });
});

describe("POST /v1/payments/decode", () => {
  test("decodifica Pix e boleto pela mesma rota", async () => {
    const { key } = await createApiKey(store, "teste", "pro");

    const pix = await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({ code: PIX }));
    assert.equal(pix.status, 200);
    assert.equal(((await pix.json()) as { kind: string }).kind, "pix");

    const boleto = await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({ code: BOLETO.line }));
    assert.equal(((await boleto.json()) as { kind: string }).kind, "boleto_cobranca");
  });

  test("conteúdo irreconhecível vira 400 com código próprio", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({ code: "qualquer coisa" }));
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unrecognized_code");
  });

  test("corpo inválido vira 400", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    for (const bad of [{}, { code: "" }, { code: 42 }, { code: "x".repeat(1025) }]) {
      assert.equal((await call(paymentsDecode, "/v1/payments/decode", key, jsonBody(bad))).status, 400, JSON.stringify(bad));
    }
  });

  test("código com verificação falhando é 200, não erro", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({ code: `${PIX.slice(0, -4)}0000` }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { valid: boolean }).valid, false);
  });

  test("exige chave de API e não consome cota em erro", async () => {
    assert.equal((await call(paymentsDecode, "/v1/payments/decode", undefined, jsonBody({ code: PIX }))).status, 401);

    const { key } = await createApiKey(store, "teste", "free");
    await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({}));
    const ok = await call(paymentsDecode, "/v1/payments/decode", key, jsonBody({ code: PIX }));
    assert.equal(ok.headers.get("x-usage-remaining"), "999");
  });
});
