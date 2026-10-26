import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import {
  buildBrCode,
  crc16,
  normalizePixKey,
  parseBrCode,
  parseTlv,
  PixError,
  sanitizeText,
} from "../lib/pix.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { POST as pixQr } from "../handlers/v1/pix/qr.js";
import { POST as pixDecode } from "../handlers/v1/pix/decode.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

/**
 * Payload de exemplo do BACEN (estático, chave aleatória, sem valor, txid "***").
 * Vem de fora deste código: é o que dá valor ao teste, já que confere o CRC e o parser contra
 * um BR Code que não foi gerado por esta implementação.
 */
const BACEN_SAMPLE =
  "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-426655440000" +
  "5204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D";

describe("crc16", () => {
  test("reproduz o CRC do payload de exemplo do BACEN", () => {
    assert.equal(crc16(BACEN_SAMPLE.slice(0, -4)), "1D3D");
  });

  test("é a variante CCITT-FALSE: o valor canônico de '123456789' é 29B1", () => {
    assert.equal(crc16("123456789"), "29B1");
  });

  test('o "6304" entra no cálculo — excluí-lo dá outro resultado', () => {
    const semMarcador = BACEN_SAMPLE.slice(0, -8);
    assert.notEqual(crc16(semMarcador), "1D3D");
  });

  test("sempre devolve 4 dígitos hexadecimais maiúsculos", () => {
    for (const input of ["", "a", "pix", "0".repeat(100)]) {
      assert.match(crc16(input), /^[0-9A-F]{4}$/);
    }
  });
});

describe("parseTlv", () => {
  test("lê ID, tamanho e valor em sequência", () => {
    const fields = parseTlv("0002010102113304abcd");
    assert.deepEqual([...(fields ?? [])], [
      ["00", "01"],
      ["01", "11"],
      ["33", "abcd"],
    ]);
  });

  test("recusa payload truncado, tamanho não numérico e ID repetido", () => {
    assert.equal(parseTlv("000201010"), null, "cabeçalho incompleto");
    assert.equal(parseTlv("0099ab"), null, "valor menor que o tamanho declarado");
    assert.equal(parseTlv("00xx01"), null, "tamanho não numérico");
    assert.equal(parseTlv("00020100020"), null, "último campo truncado");
    assert.equal(parseTlv("000201000201"), null, "ID repetido no mesmo nível");
  });

  test("tamanho zero é válido e dá valor vazio", () => {
    assert.deepEqual([...(parseTlv("0000") ?? [])], [["00", ""]]);
  });
});

describe("parseBrCode", () => {
  test("decodifica o exemplo do BACEN", () => {
    const d = parseBrCode(BACEN_SAMPLE);
    assert.ok(d);
    assert.equal(d.valid, true);
    assert.equal(d.crc_valid, true);
    assert.equal(d.kind, "static");
    assert.equal(d.key, "123e4567-e12b-12d1-a456-426655440000");
    assert.equal(d.key_type, "random");
    assert.equal(d.merchant_name, "Fulano de Tal");
    assert.equal(d.merchant_city, "BRASILIA");
    assert.equal(d.currency, "986");
    assert.equal(d.country, "BR");
    assert.equal(d.amount, null, "o exemplo não traz valor");
    assert.equal(d.txid, null, '"***" significa sem identificador');
    assert.equal(d.reusable, true, "sem o campo 01, o código é reutilizável");
  });

  test("CRC errado volta valid: false mas ainda entrega os campos", () => {
    const corrompido = `${BACEN_SAMPLE.slice(0, -4)}FFFF`;
    const d = parseBrCode(corrompido);
    assert.ok(d);
    assert.equal(d.crc_valid, false);
    assert.equal(d.valid, false);
    assert.equal(d.merchant_name, "Fulano de Tal", "quem depura precisa ver o que deu para ler");
  });

  test("qualquer alteração no payload invalida o CRC", () => {
    // Troca de mesmo tamanho, de propósito: mudar o tamanho quebraria o TLV antes do CRC,
    // e o teste passaria por outro motivo.
    const alterado = BACEN_SAMPLE.replace("Fulano de Tal", "Fulana de Tal");
    assert.notEqual(alterado, BACEN_SAMPLE);
    assert.equal(parseBrCode(alterado)?.crc_valid, false);
  });

  test("devolve null quando não é TLV válido", () => {
    for (const bad of ["", "oi", "não é br code", "0".repeat(20)]) {
      assert.equal(parseBrCode(bad), null, `deveria recusar: ${bad}`);
    }
  });

  test("reconhece BR Code dinâmico pela URL no campo 26-25", () => {
    // Tamanhos calculados, não cravados: TLV escrito à mão erra o comprimento com facilidade.
    const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;
    const account = tlv("00", "br.gov.bcb.pix") + tlv("25", "pix.exemplo.com.br/qr/v2/abc123xy");
    const body =
      tlv("00", "01") +
      tlv("01", "12") +
      tlv("26", account) +
      tlv("52", "0000") +
      tlv("53", "986") +
      tlv("54", "1.00") +
      tlv("58", "BR") +
      tlv("59", "Fulano de Tal") +
      tlv("60", "BRASILIA") +
      "6304";
    const payload = `${body}${crc16(body)}`;

    const d = parseBrCode(payload);
    assert.ok(d);
    assert.equal(d.kind, "dynamic");
    assert.equal(d.payload_url, "pix.exemplo.com.br/qr/v2/abc123xy");
    assert.equal(d.reusable, false, 'campo 01 = "12" é uso único');
    assert.equal(d.valid, true, "dinâmico não precisa de chave: a URL basta");
  });

  test("aceita CRC cujo valor é literalmente 6304", () => {
    // Payload cujo CRC calculado é "6304", então ele termina em "63046304". Procurar o
    // marcador com lastIndexOf acha a ocorrência errada e rejeita um código válido; por isso
    // parseBrCode ancora o campo 63 pelo fim. Vetor achado por busca e fixado aqui.
    const body = "00020101021162060462946304";
    assert.equal(crc16(body), "6304", "o vetor precisa continuar sendo o caso de borda");

    const payload = `${body}6304`;
    assert.ok(payload.endsWith("63046304"));
    assert.equal(parseBrCode(payload)?.crc_valid, true);
  });
});

describe("normalizePixKey", () => {
  test("identifica os cinco tipos de chave", () => {
    assert.deepEqual(normalizePixKey("123e4567-e12b-12d1-a456-426655440000"), {
      type: "random",
      key: "123e4567-e12b-12d1-a456-426655440000",
    });
    assert.deepEqual(normalizePixKey("529.982.247-25"), { type: "cpf", key: "52998224725" });
    assert.deepEqual(normalizePixKey("maria@exemplo.com.br"), { type: "email", key: "maria@exemplo.com.br" });
    assert.deepEqual(normalizePixKey("+55 (11) 99999-9999"), { type: "phone", key: "+5511999999999" });
    assert.equal(normalizePixKey("11.222.333/0001-81")?.type, "cnpj");
  });

  test("recusa CPF e CNPJ com dígito verificador errado", () => {
    assert.equal(normalizePixKey("529.982.247-26"), null);
    assert.equal(normalizePixKey("11.222.333/0001-82"), null);
  });

  test("telefone exige +55 com DDD", () => {
    assert.equal(normalizePixKey("+1 555 0100"), null, "só Brasil");
    assert.equal(normalizePixKey("+5511999"), null, "curto demais");
    assert.equal(normalizePixKey("11999999999"), null, "sem + não é telefone (e não é CPF válido)");
  });

  test("recusa vazio, e-mail inválido e lixo", () => {
    for (const bad of ["", "   ", "@", "a@b", "sem-tipo", "x".repeat(80) + "@e.com"]) {
      assert.equal(normalizePixKey(bad), null, `deveria recusar: ${bad}`);
    }
  });
});

describe("sanitizeText", () => {
  test("remove acentos preservando a letra base", () => {
    assert.equal(sanitizeText("São Paulo"), "Sao Paulo");
    assert.equal(sanitizeText("JOÃO ÁVILA JÚNIOR"), "JOAO AVILA JUNIOR");
  });

  test("descarta o que não é ASCII imprimível e normaliza espaços", () => {
    assert.equal(sanitizeText("nul\u0000aqui"), "nulaqui", "controle nao imprimivel e removido");
    assert.equal(sanitizeText("  dois   espaços  "), "dois espacos");
    assert.equal(sanitizeText("emoji 🙂 fora"), "emoji fora");
  });

  test("tab e quebra de linha viram espaço, sem fundir palavras", () => {
    // O filtro de ASCII preserva espaço em branco justamente para isto não virar "MariaSouza".
    assert.equal(sanitizeText("Maria\tSouza"), "Maria Souza");
    assert.equal(sanitizeText("Maria\nSouza"), "Maria Souza");
    assert.equal(sanitizeText("Maria \t Souza"), "Maria Souza");
  });
});

describe("buildBrCode", () => {
  const base = { key: "123e4567-e12b-12d1-a456-426655440000", name: "Fulano de Tal", city: "BRASILIA" };

  test("gera payload que volta íntegro pelo decodificador", () => {
    const payload = buildBrCode({ ...base, amount: 49.9, txid: "PEDIDO123" });
    const d = parseBrCode(payload);
    assert.ok(d);
    assert.equal(d.valid, true);
    assert.equal(d.key, base.key);
    assert.equal(d.merchant_name, "Fulano de Tal");
    assert.equal(d.amount, 49.9);
    assert.equal(d.txid, "PEDIDO123");
  });

  test("o CRC fecha quando recalculado por fora do parser", () => {
    const payload = buildBrCode(base);
    // Confere sem passar por parseBrCode, para não depender do mesmo caminho de código.
    assert.equal(payload.slice(-8, -4), "6304");
    assert.equal(crc16(payload.slice(0, -4)), payload.slice(-4));
  });

  test("começa com o indicador de formato e marca estático por padrão", () => {
    assert.ok(buildBrCode(base).startsWith("000201010211"));
    assert.equal(parseBrCode(buildBrCode(base))?.reusable, true);
    assert.equal(parseBrCode(buildBrCode({ ...base, reusable: false }))?.reusable, false);
  });

  test("valor usa ponto decimal e sempre duas casas", () => {
    assert.ok(buildBrCode({ ...base, amount: 5 }).includes("54045.00"));
    assert.ok(buildBrCode({ ...base, amount: 1234.5 }).includes("54071234.50"));
  });

  test("sem amount o campo 54 não aparece: o pagador digita o valor", () => {
    assert.equal(parseBrCode(buildBrCode(base))?.amount, null);
  });

  test('sem txid usa "***"', () => {
    assert.ok(buildBrCode(base).includes("62070503***"));
    assert.equal(parseBrCode(buildBrCode({ ...base, txid: "***" }))?.txid, null);
  });

  test("tira o acento do nome e da cidade", () => {
    const d = parseBrCode(buildBrCode({ ...base, name: "José Antônio", city: "São Paulo" }));
    assert.equal(d?.merchant_name, "Jose Antonio");
    assert.equal(d?.merchant_city, "Sao Paulo");
  });

  test("a descrição entra no campo 26 e volta na decodificação", () => {
    const d = parseBrCode(buildBrCode({ ...base, description: "Pedido 42" }));
    assert.equal(d?.description, "Pedido 42");
  });

  test("aceita todos os tipos de chave", () => {
    for (const key of ["529.982.247-25", "maria@exemplo.com.br", "+5511999999999", "11.222.333/0001-81"]) {
      const d = parseBrCode(buildBrCode({ ...base, key }));
      assert.equal(d?.valid, true, `falhou para a chave ${key}`);
    }
  });

  const rejects = (input: Parameters<typeof buildBrCode>[0], code: string) => {
    assert.throws(() => buildBrCode(input), (err: unknown) => err instanceof PixError && err.code === code, code);
  };

  test("recusa entradas fora dos limites da especificação", () => {
    rejects({ ...base, key: "chave-invalida" }, "invalid_key");
    rejects({ ...base, name: "" }, "invalid_name");
    rejects({ ...base, name: "x".repeat(26) }, "invalid_name");
    rejects({ ...base, city: "x".repeat(16) }, "invalid_city");
    rejects({ ...base, amount: 0 }, "invalid_amount");
    rejects({ ...base, amount: -1 }, "invalid_amount");
    rejects({ ...base, amount: Number.NaN }, "invalid_amount");
    rejects({ ...base, amount: 99_999_999_999.99 }, "invalid_amount");
    rejects({ ...base, txid: "com espaço" }, "invalid_txid");
    rejects({ ...base, txid: "x".repeat(26) }, "invalid_txid");
  });

  test("recusa descrição que não cabe nos 99 caracteres do campo 26", () => {
    // Chave aleatória (36) + GUI já consomem a maior parte do campo.
    rejects({ ...base, description: "x".repeat(60) }, "fields_too_long");
    // E o limite informado na mensagem precisa ser utilizável de verdade.
    assert.doesNotThrow(() => buildBrCode({ ...base, description: "x".repeat(37) }));
  });

  test("nome de 25 e cidade de 15 caracteres passam: o limite é inclusivo", () => {
    const d = parseBrCode(buildBrCode({ ...base, name: "x".repeat(25), city: "y".repeat(15) }));
    assert.equal(d?.valid, true);
  });
});

describe("POST /v1/pix/qr", () => {
  const body = { key: "123e4567-e12b-12d1-a456-426655440000", name: "Fulano de Tal", city: "BRASILIA" };

  test("devolve 201 com o BR Code e a imagem PNG", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(pixQr, "/v1/pix/qr", key, jsonBody({ ...body, amount: 10.5, txid: "ABC123" }));
    assert.equal(res.status, 201);

    const out = (await res.json()) as { br_code: string; key_type: string; image_data_url: string };
    assert.equal(out.key_type, "random");
    assert.match(out.image_data_url, /^data:image\/png;base64,/);

    const decoded = parseBrCode(out.br_code);
    assert.equal(decoded?.valid, true);
    assert.equal(decoded?.amount, 10.5);
    assert.equal(decoded?.txid, "ABC123");
  });

  test("a imagem é um PNG de verdade", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(pixQr, "/v1/pix/qr", key, jsonBody(body));
    const { image_data_url } = (await res.json()) as { image_data_url: string };
    const bytes = Buffer.from(image_data_url.split(",")[1] ?? "", "base64");
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  });

  test("erros de entrada viram 400 com o código da especificação", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const cases: [unknown, string][] = [
      [{}, "missing_fields"],
      [{ ...body, key: "nada" }, "invalid_key"],
      [{ ...body, name: "x".repeat(26) }, "invalid_name"],
      [{ ...body, amount: "10" }, "invalid_amount"],
      [{ ...body, amount: 0 }, "invalid_amount"],
      [{ ...body, txid: "com espaço" }, "invalid_txid"],
      [{ ...body, reusable: "sim" }, "invalid_reusable"],
    ];
    for (const [payload, code] of cases) {
      const res = await call(pixQr, "/v1/pix/qr", key, jsonBody(payload));
      assert.equal(res.status, 400, JSON.stringify(payload));
      const out = (await res.json()) as { error: { code: string } };
      assert.equal(out.error.code, code, JSON.stringify(payload));
    }
  });

  test("exige chave de API, como todo endpoint medido", async () => {
    assert.equal((await call(pixQr, "/v1/pix/qr", undefined, jsonBody(body))).status, 401);
  });

  test("erro de validação não consome a cota", async () => {
    const { key } = await createApiKey(store, "teste", "free");
    await call(pixQr, "/v1/pix/qr", key, jsonBody({}));
    const ok = await call(pixQr, "/v1/pix/qr", key, jsonBody(body));
    assert.equal(ok.headers.get("x-usage-remaining"), "999");
  });
});

describe("POST /v1/pix/decode", () => {
  test("abre o exemplo do BACEN", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(pixDecode, "/v1/pix/decode", key, jsonBody({ br_code: BACEN_SAMPLE }));
    assert.equal(res.status, 200);
    const out = (await res.json()) as { valid: boolean; merchant_city: string; key_type: string };
    assert.equal(out.valid, true);
    assert.equal(out.merchant_city, "BRASILIA");
    assert.equal(out.key_type, "random");
  });

  test("CRC errado é 200 com valid: false, não erro", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(pixDecode, "/v1/pix/decode", key, jsonBody({ br_code: `${BACEN_SAMPLE.slice(0, -4)}0000` }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { valid: boolean }).valid, false);
  });

  test("conteúdo que não é BR Code vira 400", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    for (const bad of [{}, { br_code: "" }, { br_code: "qualquer coisa" }, { br_code: "x".repeat(1025) }]) {
      assert.equal((await call(pixDecode, "/v1/pix/decode", key, jsonBody(bad))).status, 400);
    }
  });

  test("fecha o ciclo: o que /v1/pix/qr gera, /v1/pix/decode lê", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const created = await call(
      pixQr,
      "/v1/pix/qr",
      key,
      jsonBody({ key: "529.982.247-25", name: "José Antônio", city: "São Paulo", amount: 99.99 }),
    );
    const { br_code } = (await created.json()) as { br_code: string };

    const res = await call(pixDecode, "/v1/pix/decode", key, jsonBody({ br_code }));
    const out = (await res.json()) as Record<string, unknown>;
    assert.equal(out.valid, true);
    assert.equal(out.key, "52998224725");
    assert.equal(out.key_type, "cpf");
    assert.equal(out.merchant_name, "Jose Antonio");
    assert.equal(out.amount, 99.99);
  });
});
