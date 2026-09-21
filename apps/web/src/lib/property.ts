/**
 * Mathématiques immobilières : tableau d'amortissement et indicateurs de rendement.
 * Module pur — utilisé par la maquette et testé directement.
 */
import { parseIsoDate, toIsoDay } from './format.ts';

export interface AmortizationRow {
  readonly index: number;
  readonly date: string;
  readonly payment: number;
  readonly interest: number;
  readonly principal: number;
  readonly insurance: number;
  readonly remaining: number;
}

export interface LoanInput {
  readonly principal: number;
  /** Taux annuel en ratio (0.0132 pour 1,32 %). */
  readonly annualRate: number;
  readonly months: number;
  readonly startDate: string;
  readonly insuranceMonthly: number;
  /** Mensualité hors assurance ; calculée si absente. */
  readonly monthlyPayment?: number;
}

/** Mensualité constante d'un prêt amortissable (hors assurance). */
export function monthlyPaymentFor(principal: number, annualRate: number, months: number): number {
  if (months <= 0) return 0;
  const rate = annualRate / 12;
  if (rate === 0) return round2(principal / months);
  const factor = Math.pow(1 + rate, months);
  return round2((principal * rate * factor) / (factor - 1));
}

/** Tableau d'amortissement mensuel, assure que le solde final est nul. */
export function buildAmortization(input: LoanInput): AmortizationRow[] {
  const rate = input.annualRate / 12;
  const payment = input.monthlyPayment ?? monthlyPaymentFor(input.principal, input.annualRate, input.months);
  const start = parseIsoDate(input.startDate) ?? new Date(Date.UTC(2020, 0, 1));
  const rows: AmortizationRow[] = [];
  let remaining = input.principal;
  for (let index = 0; index < input.months && remaining > 0.005; index += 1) {
    const interest = round2(remaining * rate);
    let principalPart = round2(payment - interest);
    if (principalPart > remaining || index === input.months - 1) principalPart = round2(remaining);
    remaining = round2(remaining - principalPart);
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    rows.push({
      index: index + 1,
      date: toIsoDay(date),
      payment: round2(principalPart + interest),
      interest,
      principal: principalPart,
      insurance: round2(input.insuranceMonthly),
      remaining,
    });
  }
  return rows;
}

/** Solde restant dû à une date donnée (dernière échéance échue). */
export function balanceAt(rows: readonly AmortizationRow[], asOfIso: string): number {
  let balance = rows[0]?.remaining ?? 0;
  for (const row of rows) {
    if (row.date <= asOfIso) balance = row.remaining;
  }
  return round2(Math.max(balance, 0));
}

/** Cumul d'une colonne jusqu'à une date (intérêts payés, capital remboursé…). */
export function sumUntil(rows: readonly AmortizationRow[], asOfIso: string, pick: (row: AmortizationRow) => number): number {
  return round2(rows.filter((row) => row.date <= asOfIso).reduce((sum, row) => sum + pick(row), 0));
}

export interface PropertyMathInput {
  readonly purchasePrice: number;
  readonly notaryFees: number;
  readonly agencyFees: number;
  readonly initialWorks: number;
  readonly currentValue: number;
  readonly monthlyIncome: number;
  readonly monthlyExpenses: number;
  /** Mensualité de crédit hors assurance. */
  readonly loanPayment: number;
  readonly loanInsurance: number;
  readonly loanBalance: number;
  readonly principalRepaid: number;
  readonly interestPaid: number;
  readonly occupancyRate: number;
}

export interface PropertyMetrics {
  readonly totalCost: number;
  readonly equity: number;
  readonly loanBalance: number;
  readonly grossYield: number;
  readonly netYield: number;
  readonly yieldOnEquity: number;
  readonly downPayment: number;
  readonly monthlyIncome: number;
  readonly monthlyExpenses: number;
  readonly monthlyCashFlow: number;
  readonly monthlyCashFlowAfterLoan: number;
  readonly annualIncome: number;
  readonly annualExpenses: number;
  readonly annualCashFlow: number;
  readonly annualCashFlowAfterLoan: number;
  readonly unrealizedGain: number;
  readonly principalRepaid: number;
  readonly interestPaid: number;
  readonly occupancyRate: number;
}

/** Indicateurs de rendement (rendements exprimés en points de pourcentage). */
export function computePropertyMetrics(input: PropertyMathInput): PropertyMetrics {
  const totalCost = round2(
    input.purchasePrice + input.notaryFees + input.agencyFees + input.initialWorks,
  );
  const equity = round2(input.currentValue - input.loanBalance);
  const monthlyCashFlow = round2(input.monthlyIncome - input.monthlyExpenses);
  const monthlyCashFlowAfterLoan = round2(monthlyCashFlow - input.loanPayment - input.loanInsurance);
  const annualIncome = round2(input.monthlyIncome * 12);
  const annualExpenses = round2(input.monthlyExpenses * 12);
  const annualCashFlow = round2(monthlyCashFlow * 12);
  const annualCashFlowAfterLoan = round2(monthlyCashFlowAfterLoan * 12);
  return {
    totalCost,
    equity,
    loanBalance: round2(input.loanBalance),
    grossYield: ratio(annualIncome, input.currentValue),
    netYield: ratio(annualCashFlow, input.currentValue),
    yieldOnEquity: ratio(annualCashFlowAfterLoan, equity),
    downPayment: round2(Math.max(totalCost - (input.loanBalance + input.principalRepaid), 0)),
    monthlyIncome: round2(input.monthlyIncome),
    monthlyExpenses: round2(input.monthlyExpenses),
    monthlyCashFlow,
    monthlyCashFlowAfterLoan,
    annualIncome,
    annualExpenses,
    annualCashFlow,
    annualCashFlowAfterLoan,
    unrealizedGain: round2(input.currentValue - totalCost),
    principalRepaid: round2(input.principalRepaid),
    interestPaid: round2(input.interestPaid),
    occupancyRate: input.occupancyRate,
  };
}

/** Somme annuelle de flux d'un ensemble de loyers/charges mensualisés. */
export function annualize(monthlyAmount: number): number {
  return round2(monthlyAmount * 12);
}

/** Rendement en points de pourcentage (0 si le dénominateur est nul). */
export function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round2((numerator / denominator) * 100);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
