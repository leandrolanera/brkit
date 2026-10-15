import assert from "node:assert/strict";
import { test } from "node:test";
import { cnpjKind, formatCnpj, formatCpf, isValidCnpj, isValidCpf } from "../lib/validators.js";

test("CPF válido, com e sem máscara", () => {
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("52998224725"), true);
});

test("CPF inválido: dígito errado, repetido, tamanho", () => {
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false);
  assert.equal(isValidCpf("1234"), false);
  assert.equal(isValidCpf(""), false);
});

test("CPF formatado", () => {
  assert.equal(formatCpf("52998224725"), "529.982.247-25");
});

test("CNPJ numérico válido", () => {
  assert.equal(isValidCnpj("11.222.333/0001-81"), true);
  assert.equal(isValidCnpj("11222333000181"), true);
  assert.equal(cnpjKind("11.222.333/0001-81"), "numeric");
});

test("CNPJ alfanumérico: exemplo oficial da Receita (12.ABC.345/01DE-35)", () => {
  assert.equal(isValidCnpj("12.ABC.345/01DE-35"), true);
  assert.equal(isValidCnpj("12abc34501de35"), true);
  assert.equal(cnpjKind("12.ABC.345/01DE-35"), "alphanumeric");
  assert.equal(formatCnpj("12abc34501de35"), "12.ABC.345/01DE-35");
});

test("CNPJ inválido: dígito errado, repetido, letra no dígito verificador, tamanho", () => {
  assert.equal(isValidCnpj("12.ABC.345/01DE-36"), false);
  assert.equal(isValidCnpj("11.222.333/0001-82"), false);
  assert.equal(isValidCnpj("00.000.000/0000-00"), false);
  assert.equal(isValidCnpj("12.ABC.345/01DE-3A"), false);
  assert.equal(isValidCnpj("123"), false);
});
