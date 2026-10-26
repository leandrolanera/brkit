import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { createApiKey } from "../lib/auth.js";
import { accessKeyCheckDigit, buildAccessKey, NfeError, normalizeAccessKey, parseAccessKey } from "../lib/nfe.js";
import { createMemoryStore, setStore, type Store } from "../lib/store.js";
import { isValidCnpj } from "../lib/validators.js";
import { POST as nfeDecode } from "../handlers/v1/nfe/decode.js";
import { POST as nfeKey } from "../handlers/v1/nfe/key.js";
import { call, jsonBody } from "./helpers.js";

let store: Store;

beforeEach(() => {
  store = createMemoryStore();
  setStore(store);
});

/**
 * Vetores publicados com o cálculo resolvido, de fora desta implementação.
 *
 * NUMERICO cai no resto 1, que é a borda do módulo 11 (resto 0 ou 1 dá DV 0) — o caso que
 * separa a regra da chave da regra do boleto de cobrança, onde esses restos dariam DV 1.
 *
 * ALFANUMERICO exercita o caminho das letras (ASCII menos 48). Atenção: o CNPJ embutido nele,
 * `AB000000000001`, NÃO tem dígitos verificadores válidos — o artigo inventou o número. Isso
 * o torna um vetor melhor do que se fosse perfeito: prova que a conferência da chave e a do
 * CNPJ são independentes.
 */
const NUMERICO = { key: "35260611222333000181550010000000011000000010", soma: 342, resto: 1, dv: 0 };
const ALFANUMERICO = { key: "352607AB000000000001550010000000011000000018", soma: 421, resto: 3, dv: 8 };

/** Chave alfanumérica íntegra de verdade, com o CNPJ de exemplo oficial da Receita. */
const ALFA_VALIDA = buildAccessKey({
  uf: "SP",
  issued: "2026-07",
  cnpj: "12.ABC.345/01DE-35",
  model: "55",
  series: 1,
  number: 1,
  randomCode: "00000001",
});

describe("dígito verificador da chave", () => {
  test("reproduz o exemplo numérico publicado", () => {
    assert.equal(accessKeyCheckDigit(NUMERICO.key.slice(0, 43)), NUMERICO.dv);
  });

  test("reproduz o exemplo alfanumérico publicado", () => {
    assert.equal(accessKeyCheckDigit(ALFANUMERICO.key.slice(0, 43)), ALFANUMERICO.dv);
  });

  test("resto 0 ou 1 dá DV 0 — a borda que difere do boleto de cobrança", () => {
    // No boleto de cobrança esses mesmos restos dariam DV 1. Trocar uma regra pela outra
    // só erra em algumas chaves, o que torna o engano silencioso.
    assert.equal(NUMERICO.resto, 1, "o vetor precisa continuar caindo na borda");
    assert.equal(accessKeyCheckDigit(NUMERICO.key.slice(0, 43)), 0);
  });

  test("as letras valem o código ASCII menos 48", () => {
    // A = 17, B = 18, Z = 42. Se valessem outra coisa, as somas dos vetores não fechariam.
    const soma = (base: string) => {
      let total = 0;
      let peso = 2;
      for (let i = base.length - 1; i >= 0; i--) {
        total += (base.charCodeAt(i) - 48) * peso;
        peso = peso === 9 ? 2 : peso + 1;
      }
      return total;
    };
    assert.equal(soma(NUMERICO.key.slice(0, 43)), NUMERICO.soma);
    assert.equal(soma(ALFANUMERICO.key.slice(0, 43)), ALFANUMERICO.soma);
  });

  test("o DV sempre cabe em um dígito", () => {
    for (let i = 0; i < 400; i++) {
      const base = String(i * 7919).padStart(43, "0").slice(-43);
      const dv = accessKeyCheckDigit(base);
      assert.ok(dv >= 0 && dv <= 9, `DV fora da faixa para ${base}: ${dv}`);
    }
  });
});

describe("parseAccessKey", () => {
  test("abre todos os campos da chave numérica", () => {
    const d = parseAccessKey(NUMERICO.key);
    assert.ok(d);
    assert.equal(d.valid, true);
    assert.deepEqual(d.errors, []);
    assert.equal(d.uf, "SP");
    assert.equal(d.uf_code, "35");
    assert.equal(d.issued, "2026-06");
    assert.equal(d.cnpj, "11222333000181");
    assert.equal(d.cnpj_kind, "numeric");
    assert.equal(d.cnpj_valid, true);
    assert.equal(d.model, "55");
    assert.equal(d.model_name, "NF-e");
    assert.equal(d.series, "001");
    assert.equal(d.number, "000000001");
    assert.equal(d.emission_type, "1");
    assert.equal(d.emission_type_name, "Normal");
    assert.equal(d.random_code, "00000001");
    assert.equal(d.check_digit, "0");
  });

  test("reconhece a chave alfanumérica", () => {
    const d = parseAccessKey(ALFA_VALIDA);
    assert.equal(d?.valid, true);
    assert.equal(d?.cnpj_kind, "alphanumeric");
    assert.equal(d?.cnpj, "12ABC34501DE35");
    assert.equal(d?.cnpj_valid, true);
  });

  test("dígito da chave e dígitos do CNPJ são conferidos em separado", () => {
    // O vetor publicado tem DV de chave correto e CNPJ inventado.
    assert.equal(isValidCnpj("AB000000000001"), false, "a premissa do vetor");
    const d = parseAccessKey(ALFANUMERICO.key);
    assert.equal(d?.check_digit_valid, true, "o dígito da chave está certo");
    assert.equal(d?.cnpj_valid, false, "mas o CNPJ embutido não");
    assert.equal(d?.valid, false);
    assert.deepEqual(d?.errors, ["invalid_cnpj"]);
  });

  test("dígito verificador errado é apontado, e os campos continuam legíveis", () => {
    const dv = NUMERICO.key[43]!;
    const outro = dv === "9" ? "8" : String(Number(dv) + 1);
    const d = parseAccessKey(NUMERICO.key.slice(0, 43) + outro);
    assert.equal(d?.valid, false);
    assert.equal(d?.check_digit_valid, false);
    assert.ok(d?.errors.includes("invalid_check_digit"));
    assert.equal(d?.uf, "SP", "quem digitou errado precisa ver o resto");
  });

  test("ignora pontuação e aceita minúsculas", () => {
    const sujo = ` ${ALFA_VALIDA.slice(0, 20).toLowerCase()}.${ALFA_VALIDA.slice(20)} `;
    const d = parseAccessKey(sujo);
    assert.equal(d?.valid, true);
    assert.equal(d?.key, ALFA_VALIDA, "a chave normalizada volta em maiúsculas e sem pontuação");
  });

  test("código de UF inexistente é sinalizado", () => {
    const base = "99" + NUMERICO.key.slice(2, 43);
    const d = parseAccessKey(base + accessKeyCheckDigit(base));
    assert.equal(d?.uf, null);
    assert.ok(d?.errors.includes("unknown_uf_code"));
  });

  test("mês fora de 01-12 é sinalizado", () => {
    const base = NUMERICO.key.slice(0, 4) + "13" + NUMERICO.key.slice(6, 43);
    const d = parseAccessKey(base + accessKeyCheckDigit(base));
    assert.ok(d?.errors.includes("invalid_month"));
  });

  test("modelo fora da tabela volta null, não um nome inventado", () => {
    const base = NUMERICO.key.slice(0, 20) + "99" + NUMERICO.key.slice(22, 43);
    const d = parseAccessKey(base + accessKeyCheckDigit(base));
    assert.equal(d?.model, "99");
    assert.equal(d?.model_name, null);
  });

  test("reconhece os quatro modelos da especificação", () => {
    for (const [model, name] of [["55", "NF-e"], ["57", "CT-e"], ["58", "MDF-e"], ["65", "NFC-e"]] as const) {
      const base = NUMERICO.key.slice(0, 20) + model + NUMERICO.key.slice(22, 43);
      assert.equal(parseAccessKey(base + accessKeyCheckDigit(base))?.model_name, name);
    }
  });

  test("devolve null para o que não tem a forma de chave", () => {
    for (const bad of ["", "123", "x".repeat(44), NUMERICO.key.slice(0, 43), `${NUMERICO.key}0`]) {
      assert.equal(parseAccessKey(bad), null, `deveria recusar: ${bad.slice(0, 20)}`);
    }
  });

  test("letra fora das 12 posições do CNPJ não é chave válida", () => {
    // Só a raiz e a ordem do CNPJ aceitam letras; os 6 primeiros e os 26 finais são numéricos.
    const letraNoComeco = "A" + NUMERICO.key.slice(1);
    const letraNoFim = NUMERICO.key.slice(0, 43) + "A";
    assert.equal(parseAccessKey(letraNoComeco), null);
    assert.equal(parseAccessKey(letraNoFim), null);
  });
});

describe("buildAccessKey", () => {
  test("reproduz exatamente a chave numérica publicada", () => {
    const key = buildAccessKey({
      uf: "SP",
      issued: "2026-06",
      cnpj: "11222333000181",
      model: "55",
      series: 1,
      number: 1,
      emissionType: 1,
      randomCode: "00000001",
    });
    assert.equal(key, NUMERICO.key);
  });

  test("aceita a UF pela sigla ou pelo código do IBGE", () => {
    const porSigla = buildAccessKey({ uf: "SP", issued: "2606", cnpj: "11222333000181", model: "55", series: 1, number: 1, randomCode: "00000001" });
    const porCodigo = buildAccessKey({ uf: "35", issued: "2606", cnpj: "11222333000181", model: "55", series: 1, number: 1, randomCode: "00000001" });
    assert.equal(porSigla, porCodigo);
  });

  test("aceita a data como AAAA-MM ou AAMM", () => {
    const comum = { uf: "SP", cnpj: "11222333000181", model: "55", series: 1, number: 1, randomCode: "00000001" };
    assert.equal(buildAccessKey({ ...comum, issued: "2026-06" }), buildAccessKey({ ...comum, issued: "2606" }));
  });

  test("completa série, número e cNF com zeros à esquerda", () => {
    const d = parseAccessKey(
      buildAccessKey({ uf: "SP", issued: "2606", cnpj: "11222333000181", model: "55", series: 7, number: 42, randomCode: "1" }),
    );
    assert.equal(d?.series, "007");
    assert.equal(d?.number, "000000042");
    assert.equal(d?.random_code, "00000001");
  });

  test("o que sai sempre passa na leitura", () => {
    const d = parseAccessKey(ALFA_VALIDA);
    assert.equal(d?.valid, true);
    assert.equal(ALFA_VALIDA.length, 44);
  });

  test("sorteia o cNF quando não informado", () => {
    const comum = { uf: "SP", issued: "2606", cnpj: "11222333000181", model: "55", series: 1, number: 1 };
    const chaves = new Set(Array.from({ length: 20 }, () => buildAccessKey(comum)));
    assert.ok(chaves.size > 1, "cNF é um código aleatório, não uma constante");
    for (const chave of chaves) assert.equal(parseAccessKey(chave)?.valid, true);
  });

  const recusa = (input: Parameters<typeof buildAccessKey>[0], code: string) => {
    assert.throws(() => buildAccessKey(input), (err: unknown) => err instanceof NfeError && err.code === code, code);
  };

  test("recusa entradas fora da especificação", () => {
    const base = { uf: "SP", issued: "2606", cnpj: "11222333000181", model: "55", series: 1, number: 1 };
    recusa({ ...base, uf: "XX" }, "invalid_uf");
    recusa({ ...base, issued: "2613" }, "invalid_issued");
    recusa({ ...base, issued: "26" }, "invalid_issued");
    recusa({ ...base, cnpj: "11222333000182" }, "invalid_cnpj");
    recusa({ ...base, randomCode: "123456789" }, "invalid_random_code");
  });

  test("CNPJ com dígito errado é recusado na montagem", () => {
    // Montar a chave com CNPJ inválido produziria documento recusado pela SEFAZ.
    recusa({ uf: "SP", issued: "2606", cnpj: "12ABC34501DE36", model: "55", series: 1, number: 1 }, "invalid_cnpj");
  });
});

describe("normalizeAccessKey", () => {
  test("remove espaço e pontuação e sobe para maiúsculas", () => {
    assert.equal(normalizeAccessKey(" 3526 07ab-cd/ef "), "352607ABCDEF");
  });
});

describe("POST /v1/nfe/decode", () => {
  test("abre a chave publicada", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(nfeDecode, "/v1/nfe/decode", key, jsonBody({ key: NUMERICO.key }));
    assert.equal(res.status, 200);
    const out = (await res.json()) as { valid: boolean; uf: string; model_name: string };
    assert.equal(out.valid, true);
    assert.equal(out.uf, "SP");
    assert.equal(out.model_name, "NF-e");
  });

  test("dígito errado é 200 com valid false, não erro", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const quebrada = NUMERICO.key.slice(0, 43) + "9";
    const res = await call(nfeDecode, "/v1/nfe/decode", key, jsonBody({ key: quebrada }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { valid: boolean }).valid, false);
  });

  test("conteúdo sem forma de chave vira 400", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    for (const bad of [{}, { key: "" }, { key: "123" }, { key: "x".repeat(44) }, { key: "y".repeat(100) }]) {
      assert.equal((await call(nfeDecode, "/v1/nfe/decode", key, jsonBody(bad))).status, 400, JSON.stringify(bad));
    }
  });

  test("exige chave de API", async () => {
    assert.equal((await call(nfeDecode, "/v1/nfe/decode", undefined, jsonBody({ key: NUMERICO.key }))).status, 401);
  });
});

describe("POST /v1/nfe/key", () => {
  test("monta a chave e devolve já decodificada", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const res = await call(
      nfeKey,
      "/v1/nfe/key",
      key,
      jsonBody({ uf: "SP", issued: "2026-06", cnpj: "11.222.333/0001-81", model: "55", series: 1, number: 1, randomCode: "00000001" }),
    );
    assert.equal(res.status, 201);
    const out = (await res.json()) as { key: string; details: { valid: boolean; uf: string } };
    assert.equal(out.key, NUMERICO.key);
    assert.equal(out.details.valid, true);
    assert.equal(out.details.uf, "SP");
  });

  test("entradas inválidas viram 400 com o código da especificação", async () => {
    const { key } = await createApiKey(store, "teste", "pro");
    const base = { uf: "SP", issued: "2026-06", cnpj: "11222333000181", model: "55", series: 1, number: 1 };
    const casos: [unknown, string][] = [
      [{}, "missing_fields"],
      [{ ...base, uf: undefined }, "missing_fields"],
      [{ ...base, uf: "XX" }, "invalid_uf"],
      [{ ...base, issued: "2613" }, "invalid_issued"],
      [{ ...base, cnpj: "11222333000182" }, "invalid_cnpj"],
    ];
    for (const [payload, code] of casos) {
      const res = await call(nfeKey, "/v1/nfe/key", key, jsonBody(payload));
      assert.equal(res.status, 400, JSON.stringify(payload));
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, code, JSON.stringify(payload));
    }
  });

  test("erro de validação não consome a cota", async () => {
    const { key } = await createApiKey(store, "teste", "free");
    await call(nfeKey, "/v1/nfe/key", key, jsonBody({}));
    const ok = await call(nfeDecode, "/v1/nfe/decode", key, jsonBody({ key: NUMERICO.key }));
    assert.equal(ok.headers.get("x-usage-remaining"), "999");
  });
});
