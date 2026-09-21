import { round, sum } from './money.ts';
import type {
  PropertyCashFlowEntry,
  PropertyDetails,
  PropertyMetrics,
} from './types.ts';

/**
 * Immobilier : échéancier de crédit, agrégation des revenus/charges récurrents
 * et indicateurs de rendement.
 *
 * Toutes les fonctions sont pures et reçoivent des dates ISO `YYYY-MM-DD`, ce qui
 * les rend testables et indépendantes de la base.
 */

const DAY_MS = 86_400_000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function addMonths(date: string, months: number): string {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0)).getUTCDate();
  parsed.setUTCDate(Math.min(day, lastDay));
  return parsed.toISOString().slice(0, 10);
}

export interface AmortizationRow {
  readonly index: number;
  readonly date: string;
  readonly payment: number;
  readonly interest: number;
  readonly principal: number;
  readonly insurance: number;
  readonly remaining: number;
}

export interface AmortizationSchedule {
  readonly rows: readonly AmortizationRow[];
  readonly monthlyPayment: number;
  readonly totalInterest: number;
  readonly totalInsurance: number;
  readonly totalPaid: number;
  readonly interestPaidToDate: number;
  readonly principalRepaidToDate: number;
  readonly remainingPrincipal: number;
  readonly endDate: string;
}

export interface AmortizationInput {
  readonly principal: number;
  readonly annualRate: number;
  readonly months: number;
  readonly startDate: string;
  readonly insuranceMonthly?: number;
  /** Mensualité imposée (crédit existant) : si absente elle est calculée. */
  readonly monthlyPayment?: number;
  /** Date de référence pour « payé à ce jour » (par défaut : aujourd'hui). */
  readonly asOf?: string;
}

/** Mensualité constante d'un crédit amortissable : m = C * i / (1 - (1+i)^-n). */
export function monthlyPayment(principal: number, annualRate: number, months: number): number {
  if (months <= 0) return 0;
  const i = annualRate / 100 / 12;
  if (i === 0) return round(principal / months, 2);
  return round((principal * i) / (1 - (1 + i) ** -months), 2);
}

export function amortizationSchedule(input: AmortizationInput): AmortizationSchedule {
  const insurance = input.insuranceMonthly ?? 0;
  // Une mensualité stockée à 0 (ou absente) signifie « à recalculer » : on ne
  // l'utilise jamais telle quelle, sinon l'échéancier ne rembourse rien.
  const payment =
    input.monthlyPayment && input.monthlyPayment > 0
      ? input.monthlyPayment
      : monthlyPayment(input.principal, input.annualRate, input.months);
  const i = input.annualRate / 100 / 12;
  const rows: AmortizationRow[] = [];
  let remaining = input.principal;
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);

  if (i > 0 && payment <= input.principal * i) {
    throw new Error(
      `Mensualité de ${payment} insuffisante : elle ne couvre pas les intérêts ` +
        `(${round(input.principal * i, 2)}) — le crédit ne s'amortirait jamais.`,
    );
  }

  for (let index = 1; index <= input.months && remaining > 0.005; index++) {
    const interest = round(remaining * i, 2);
    let principal = round(payment - interest, 2);
    if (principal > remaining) principal = remaining;
    remaining = round(remaining - principal, 2);
    rows.push({
      index,
      date: addMonths(input.startDate, index),
      payment: round(principal + interest, 2),
      interest,
      principal,
      insurance: round(insurance, 2),
      remaining,
    });
  }

  const paidRows = rows.filter((row) => row.date <= asOf);
  return {
    rows,
    monthlyPayment: payment,
    totalInterest: round(sum(rows.map((r) => r.interest))),
    totalInsurance: round(sum(rows.map((r) => r.insurance))),
    totalPaid: round(sum(rows.map((r) => r.payment + r.insurance))),
    interestPaidToDate: round(sum(paidRows.map((r) => r.interest))),
    principalRepaidToDate: round(sum(paidRows.map((r) => r.principal))),
    remainingPrincipal: rows.length
      ? (paidRows.length ? (paidRows[paidRows.length - 1] as AmortizationRow).remaining : input.principal)
      : 0,
    endDate: rows.length ? (rows[rows.length - 1] as AmortizationRow).date : input.startDate,
  };
}

/** Étend les entrées récurrentes en occurrences concrètes sur [from, to]. */
export function expandRecurring(
  entries: readonly PropertyCashFlowEntry[],
  from: string,
  to: string,
): PropertyCashFlowEntry[] {
  const out: PropertyCashFlowEntry[] = [];
  for (const entry of entries) {
    if (entry.recurrence === 'ONE_OFF') {
      if (entry.date >= from && entry.date <= to) out.push(entry);
      continue;
    }
    const stepMonths = entry.recurrence === 'MONTHLY' ? 1 : entry.recurrence === 'QUARTERLY' ? 3 : 12;
    let cursor = entry.date;
    let guard = 0;
    while (cursor <= to && guard < 2000) {
      if (cursor >= from) out.push({ ...entry, date: cursor, recurrence: 'ONE_OFF' });
      cursor = addMonths(cursor, stepMonths);
      guard++;
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface PropertyMetricsInput {
  readonly property: PropertyDetails;
  readonly cashFlows: readonly PropertyCashFlowEntry[];
  /** Apport effectif (sinon : prix + frais - capital emprunté). */
  readonly downPayment?: number;
  /** Année d'analyse pour les rendements (par défaut : 12 derniers mois glissants). */
  readonly asOf?: string;
}

export function computePropertyMetrics(input: PropertyMetricsInput): PropertyMetrics {
  const { property } = input;
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const from = addMonths(asOf, -12);

  const oneOff = input.cashFlows.filter((entry) => entry.recurrence === 'ONE_OFF');
  const recurring = input.cashFlows.filter((entry) => entry.recurrence !== 'ONE_OFF');
  // Les ponctuels sont comptés sur leur date, les récurrents sont annualisés.
  const annual = expandRecurring(recurring, from, asOf);
  const windowed = [...oneOff.filter((e) => e.date >= from && e.date <= asOf), ...annual];

  const income = windowed.filter((e) => e.direction === 'INCOME');
  const expenses = windowed.filter((e) => e.direction === 'EXPENSE');
  const receivedIncome = income.filter((e) => e.received);

  const annualIncome = round(sum(receivedIncome.map((e) => Math.abs(e.amount))));
  // Charges annuelles : intérêts + assurance du crédit inclus, mais PAS le capital.
  const loanSchedule = property.loan
    ? amortizationSchedule({
        principal: property.loan.principal,
        annualRate: property.loan.annualRate,
        months: property.loan.months,
        startDate: property.loan.startDate,
        insuranceMonthly: property.loan.insuranceMonthly,
        monthlyPayment: property.loan.monthlyPayment,
        asOf,
      })
    : null;
  const loanYearlyInterest = loanSchedule
    ? round(sum(loanSchedule.rows.filter((r) => r.date >= from && r.date <= asOf).map((r) => r.interest)))
    : 0;
  const loanYearlyInsurance = loanSchedule
    ? round(
        sum(loanSchedule.rows.filter((r) => r.date >= from && r.date <= asOf).map((r) => r.insurance)),
      )
    : 0;
  const loanYearlyPrincipal = loanSchedule
    ? round(sum(loanSchedule.rows.filter((r) => r.date >= from && r.date <= asOf).map((r) => r.principal)))
    : 0;
  const loanYearlyPayments = loanSchedule
    ? round(
        sum(
          loanSchedule.rows
            .filter((r) => r.date >= from && r.date <= asOf)
            .map((r) => r.payment + r.insurance),
        ),
      )
    : 0;

  const operatingExpenses = round(sum(expenses.map((e) => Math.abs(e.amount))));
  const annualExpenses = round(operatingExpenses + loanYearlyInterest + loanYearlyInsurance);
  const annualCashFlow = round(annualIncome - annualExpenses);
  const annualCashFlowAfterLoan = round(annualIncome - annualExpenses - loanYearlyPrincipal);

  const totalCost = round(
    property.purchasePrice + property.notaryFees + property.agencyFees + property.initialWorks,
  );
  const loanBalance = loanSchedule ? loanSchedule.remainingPrincipal : 0;
  const downPayment =
    input.downPayment ?? round(Math.max(0, totalCost - (property.loan?.principal ?? 0)));
  const equity = round(property.currentValue - loanBalance);

  const grossYield = property.currentValue > 0 ? round((annualIncome / property.currentValue) * 100, 4) : 0;
  const netYield = property.currentValue > 0 ? round((annualCashFlow / property.currentValue) * 100, 4) : 0;
  const yieldOnEquity = downPayment > 0 ? round((annualCashFlow / downPayment) * 100, 4) : 0;

  const monthsWindow = Math.max(1, Math.round(daysBetween(from, asOf) / 30.44));
  // Taux d'occupation : mois de la fenêtre où un loyer a effectivement été encaissé.
  const rentMonths = new Set(
    income.filter((e) => e.category === 'RENT' && e.received).map((e) => e.date.slice(0, 7)),
  );
  const occupancyRate =
    monthsWindow > 0 ? round(Math.min(100, (rentMonths.size / monthsWindow) * 100), 2) : 100;

  return {
    accountId: property.accountId,
    currentValue: round(property.currentValue),
    totalCost,
    loanBalance,
    equity,
    grossYield,
    netYield,
    yieldOnEquity,
    downPayment,
    monthlyIncome: round(annualIncome / 12),
    monthlyExpenses: round(annualExpenses / 12),
    monthlyCashFlow: round(annualCashFlow / 12),
    monthlyCashFlowAfterLoan: round(annualCashFlowAfterLoan / 12),
    annualIncome,
    annualExpenses,
    annualCashFlow,
    annualCashFlowAfterLoan,
    unrealizedGain: round(property.currentValue - totalCost),
    principalRepaid: loanSchedule ? loanSchedule.principalRepaidToDate : 0,
    interestPaid: loanSchedule ? loanSchedule.interestPaidToDate : 0,
    loanYearlyPayments,
    loanYearlyPrincipal,
    occupancyRate,
  };
}

/** Cash-flow net d'un bien sur un mois donné : loyer encaissé - charges du mois - échéance. */
export function monthlyPropertyCashFlow(
  property: PropertyDetails,
  cashFlows: readonly PropertyCashFlowEntry[],
  month: string,
): { income: number; expenses: number; loanPayment: number; net: number } {
  const from = `${month.slice(0, 7)}-01`;
  const to = addMonths(from, 1);
  const endOfMonth = new Date(Date.parse(to) - DAY_MS).toISOString().slice(0, 10);
  const windowed = expandRecurring(cashFlows, from, endOfMonth);
  const income = round(
    sum(windowed.filter((e) => e.direction === 'INCOME' && e.received).map((e) => Math.abs(e.amount))),
  );
  const expenses = round(
    sum(windowed.filter((e) => e.direction === 'EXPENSE').map((e) => Math.abs(e.amount))),
  );
  let loanPayment = 0;
  if (property.loan) {
    const schedule = amortizationSchedule({
      principal: property.loan.principal,
      annualRate: property.loan.annualRate,
      months: property.loan.months,
      startDate: property.loan.startDate,
      insuranceMonthly: property.loan.insuranceMonthly,
      monthlyPayment: property.loan.monthlyPayment,
      asOf: endOfMonth,
    });
    const row = schedule.rows.find((r) => r.date >= from && r.date <= endOfMonth);
    loanPayment = row ? round(row.payment + row.insurance) : 0;
  }
  return { income, expenses, loanPayment, net: round(income - expenses - loanPayment) };
}