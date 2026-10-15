/** Validação algorítmica de CPF e CNPJ (inclui o CNPJ alfanumérico em uso desde julho de 2026). */

export function normalizeCpf(input: string): string {
  return input.replace(/\D/g, "");
}

export function isValidCpf(input: string): boolean {
  const d = normalizeCpf(input);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digits = d.split("").map(Number);
  const check = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i]! * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === digits[9] && check(10) === digits[10];
}

export function formatCpf(input: string): string {
  const d = normalizeCpf(input);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9, 11)}`;
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeCnpj(input: string): string {
  return input.replace(/[.\/\-\s]/g, "").toUpperCase();
}

/** Módulo 11; cada caractere vale (código ASCII − 48), de modo que 0–9 seguem valendo 0–9. */
function cnpjDigit(chars: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += (chars.charCodeAt(i) - 48) * weights[i]!;
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

export function isValidCnpj(input: string): boolean {
  const c = normalizeCnpj(input);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;
  if (/^(.)\1{13}$/.test(c)) return false;
  const base = c.slice(0, 12);
  const d1 = cnpjDigit(base, CNPJ_W1);
  const d2 = cnpjDigit(base + d1, CNPJ_W2);
  return c.slice(12) === `${d1}${d2}`;
}

export function cnpjKind(input: string): "numeric" | "alphanumeric" {
  return /[A-Z]/.test(normalizeCnpj(input).slice(0, 12)) ? "alphanumeric" : "numeric";
}

export function formatCnpj(input: string): string {
  const c = normalizeCnpj(input);
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12, 14)}`;
}
