import assert from "node:assert/strict";
import { test } from "node:test";
import { businessDays, easterSunday, holidaysForYear, parseIsoDate } from "../lib/holidays.js";

test("Páscoa 2026 e feriados móveis derivados", () => {
  assert.equal(easterSunday(2026), "2026-04-05");
  const byName = Object.fromEntries(holidaysForYear(2026).map((h) => [h.name, h]));
  assert.equal(byName["Sexta-feira Santa"]?.date, "2026-04-03");
  assert.equal(byName["Carnaval (terça-feira)"]?.date, "2026-02-17");
  assert.equal(byName["Corpus Christi"]?.date, "2026-06-04");
  assert.equal(byName["Sexta-feira Santa"]?.type, "national");
  assert.equal(byName["Corpus Christi"]?.type, "optional");
});

test("Consciência Negra só é nacional a partir de 2024", () => {
  assert.equal(holidaysForYear(2023).some((h) => h.date === "2023-11-20"), false);
  assert.equal(holidaysForYear(2024).some((h) => h.date === "2024-11-20"), true);
});

test("lista ordenada por data", () => {
  const dates = holidaysForYear(2026).map((h) => h.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("dias úteis de outubro de 2026 (22 dias de semana menos o feriado de 12/10)", () => {
  const result = businessDays(parseIsoDate("2026-10-01")!, parseIsoDate("2026-10-31")!);
  assert.equal(result.total_days, 31);
  assert.equal(result.business_days, 21);
  assert.deepEqual(result.holidays_excluded.map((h) => h.date), ["2026-10-12"]);
});

test("ponto facultativo não é descontado dos dias úteis", () => {
  const result = businessDays(parseIsoDate("2026-06-04")!, parseIsoDate("2026-06-04")!);
  assert.equal(result.business_days, 1);
});

test("datas ISO inválidas são rejeitadas", () => {
  assert.equal(parseIsoDate("2026-02-30"), null);
  assert.equal(parseIsoDate("26-10-01"), null);
  assert.equal(parseIsoDate(null), null);
});
