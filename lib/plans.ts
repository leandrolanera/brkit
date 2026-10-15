export type PlanId = "free" | "pro" | "scale";
export type PaidPlanId = Exclude<PlanId, "free">;

export interface Plan {
  /** Chamadas bem-sucedidas por mês (UTC). */
  monthlyQuota: number;
  /** Requisições por minuto, contando também as que falham. */
  perMinute: number;
  /** Mensalidade em reais (0 = gratuito). */
  priceBRL: number;
}

/** Valores provisórios: ajuste depois de medir custo real e disposição a pagar. */
export const PLANS: Record<PlanId, Plan> = {
  free: { monthlyQuota: 1_000, perMinute: 10, priceBRL: 0 },
  pro: { monthlyQuota: 50_000, perMinute: 120, priceBRL: 49 },
  scale: { monthlyQuota: 500_000, perMinute: 600, priceBRL: 249 },
};

/** Dias de acesso concedidos por mensalidade paga: ciclo mensal + tolerância para renovação. */
export const BILLING_CYCLE_DAYS = 31;
export const GRACE_DAYS = 3;

export function isPlanId(value: string): value is PlanId {
  return value in PLANS;
}

export function isPaidPlan(value: unknown): value is PaidPlanId {
  return value === "pro" || value === "scale";
}
