export interface Holiday {
  date: string;
  name: string;
  /** national = feriado federal; optional = ponto facultativo. */
  type: "national" | "optional";
}

const DAY_MS = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), em milissegundos UTC. */
function easterMs(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

export function easterSunday(year: number): string {
  return iso(easterMs(year));
}

/** Feriados nacionais e pontos facultativos federais. Municipais e estaduais ficam para uma próxima versão. */
export function holidaysForYear(year: number): Holiday[] {
  const easter = easterMs(year);
  const list: Holiday[] = [
    { date: `${year}-01-01`, name: "Confraternização Universal", type: "national" },
    { date: iso(easter - 48 * DAY_MS), name: "Carnaval (segunda-feira)", type: "optional" },
    { date: iso(easter - 47 * DAY_MS), name: "Carnaval (terça-feira)", type: "optional" },
    { date: iso(easter - 2 * DAY_MS), name: "Sexta-feira Santa", type: "national" },
    { date: `${year}-04-21`, name: "Tiradentes", type: "national" },
    { date: `${year}-05-01`, name: "Dia do Trabalho", type: "national" },
    { date: iso(easter + 60 * DAY_MS), name: "Corpus Christi", type: "optional" },
    { date: `${year}-09-07`, name: "Independência do Brasil", type: "national" },
    { date: `${year}-10-12`, name: "Nossa Senhora Aparecida", type: "national" },
    { date: `${year}-11-02`, name: "Finados", type: "national" },
    { date: `${year}-11-15`, name: "Proclamação da República", type: "national" },
    { date: `${year}-12-25`, name: "Natal", type: "national" },
  ];
  // Dia da Consciência Negra é feriado nacional desde 2024 (Lei 14.759/2023).
  if (year >= 2024) {
    list.push({ date: `${year}-11-20`, name: "Dia da Consciência Negra", type: "national" });
  }
  return list.sort((x, y) => x.date.localeCompare(y.date));
}

export function parseIsoDate(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || iso(ms) !== value) return null;
  return ms;
}

export interface BusinessDaysResult {
  from: string;
  to: string;
  total_days: number;
  business_days: number;
  holidays_excluded: Holiday[];
}

/** Dias úteis entre duas datas (inclusive): exclui sábados, domingos e feriados nacionais. */
export function businessDays(fromMs: number, toMs: number): BusinessDaysResult {
  const cache = new Map<number, Holiday[]>();
  const national = (year: number) => {
    let list = cache.get(year);
    if (!list) {
      list = holidaysForYear(year).filter((h) => h.type === "national");
      cache.set(year, list);
    }
    return list;
  };

  let business = 0;
  let total = 0;
  const excluded: Holiday[] = [];
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    total++;
    const weekday = new Date(t).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = iso(t);
    const holiday = national(new Date(t).getUTCFullYear()).find((h) => h.date === date);
    if (holiday) {
      excluded.push(holiday);
      continue;
    }
    business++;
  }
  return { from: iso(fromMs), to: iso(toMs), total_days: total, business_days: business, holidays_excluded: excluded };
}
