/** Biens immobiliers de la maquette : prêts, flux, valorisation, amortissement. */
import type { PropertyCashFlowDto, PropertyDto, PropertyLoanDto } from '@suiviinvest/api-contract';
import { balanceAt, buildAmortization, computePropertyMetrics, sumUntil } from '../lib/property.ts';
import { toIsoDay } from '../lib/format.ts';
import { round2 } from './random.ts';

interface PropertyInput {
  readonly accountId: string;
  readonly name: string;
  readonly kind: string;
  readonly address: string;
  readonly purchaseDate: string;
  readonly purchasePrice: number;
  readonly notaryFees: number;
  readonly agencyFees: number;
  readonly initialWorks: number;
  readonly surfaceM2: number;
  readonly currentValue: number;
  readonly notes: string;
  readonly rentMonthly: number;
  readonly expensesMonthly: number;
  readonly occupancyRate: number;
  readonly loan: {
    readonly loanType: string;
    readonly principal: number;
    readonly annualRate: number;
    readonly months: number;
    readonly startDate: string;
    readonly insuranceMonthly: number;
  } | null;
  readonly cashFlows: readonly Omit<PropertyCashFlowDto, 'id'>[];
}

const PROPERTY_INPUTS: readonly PropertyInput[] = [
  {
    accountId: 'acc-re-lyon',
    name: 'Appartement Lyon 3e',
    kind: 'APPARTEMENT',
    address: '12 rue des Girondins, 69003 Lyon',
    purchaseDate: '2019-06-14',
    purchasePrice: 268000,
    notaryFees: 20100,
    agencyFees: 0,
    initialWorks: 12500,
    surfaceM2: 62,
    currentValue: 341000,
    notes: 'T3 loué nu, locataire en place depuis 2021.',
    rentMonthly: 1150,
    expensesMonthly: 156,
    occupancyRate: 1,
    loan: { loanType: 'AMORTISSABLE', principal: 214000, annualRate: 0.0132, months: 240, startDate: '2019-07-01', insuranceMonthly: 38.5 },
    cashFlows: [
      { direction: 'INCOME', category: 'RENT', label: 'Loyer nu', amount: 1150, currency: 'EUR', date: '2026-09-01', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'CONDO_FEES', label: 'Charges de copropriété', amount: 96, currency: 'EUR', date: '2026-09-05', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'INSURANCE', label: 'Assurance bailleur', amount: 24, currency: 'EUR', date: '2026-09-05', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'MANAGEMENT', label: 'Gestion locative', amount: 36, currency: 'EUR', date: '2026-09-05', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'PROPERTY_TAX', label: 'Taxe foncière', amount: 1180, currency: 'EUR', date: '2026-10-15', recurrence: 'YEARLY', received: false },
    ],
  },
  {
    accountId: 'acc-re-nantes',
    name: 'Studio Nantes',
    kind: 'STUDIO',
    address: '5 boulevard de Berlin, 44000 Nantes',
    purchaseDate: '2022-03-05',
    purchasePrice: 142000,
    notaryFees: 10650,
    agencyFees: 4200,
    initialWorks: 8000,
    surfaceM2: 24,
    currentValue: 158500,
    notes: 'Studio meublé, bail étudiant.',
    rentMonthly: 620,
    expensesMonthly: 88,
    occupancyRate: 0.92,
    loan: { loanType: 'AMORTISSABLE', principal: 106500, annualRate: 0.0185, months: 240, startDate: '2022-04-01', insuranceMonthly: 22.4 },
    cashFlows: [
      { direction: 'INCOME', category: 'RENT', label: 'Loyer meublé', amount: 620, currency: 'EUR', date: '2026-09-01', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'CONDO_FEES', label: 'Charges de copropriété', amount: 58, currency: 'EUR', date: '2026-09-05', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'INSURANCE', label: 'Assurance propriétaire non occupant', amount: 18, currency: 'EUR', date: '2026-09-05', recurrence: 'MONTHLY', received: true },
      { direction: 'EXPENSE', category: 'PROPERTY_TAX', label: 'Taxe foncière', amount: 640, currency: 'EUR', date: '2026-10-15', recurrence: 'YEARLY', received: false },
    ],
  },
];

const APPRECIATION_NOTES: Readonly<Record<string, readonly { date: string; value: number; note: string }[]>> = {
  'acc-re-lyon': [
    { date: '2019-06-14', value: 268000, note: 'Acquisition' },
    { date: '2021-06-14', value: 292000, note: 'Estimation agence' },
    { date: '2023-06-14', value: 318000, note: 'Estimation agence' },
    { date: '2026-09-01', value: 341000, note: 'Estimation DVF + travaux' },
  ],
  'acc-re-nantes': [
    { date: '2022-03-05', value: 142000, note: 'Acquisition' },
    { date: '2024-03-05', value: 150000, note: 'Estimation agence' },
    { date: '2026-09-01', value: 158500, note: 'Estimation DVF' },
  ],
};

function buildProperty(input: PropertyInput, now: Date): PropertyDto {
  const amortization = input.loan === null ? [] : buildAmortization(input.loan);
  const asOfIso = toIsoDay(now);
  const loanBalance = input.loan === null ? 0 : balanceAt(amortization, asOfIso);
  const principalRepaid = input.loan === null ? 0 : round2(input.loan.principal - loanBalance);
  const interestPaid = sumUntil(amortization, asOfIso, (row) => row.interest);
  const totalInterest = round2(amortization.reduce((sum, row) => sum + row.interest, 0));
  const loanPayment = amortization[0]?.payment ?? 0;
  const loan: PropertyLoanDto | null =
    input.loan === null
      ? null
      : {
          loanType: input.loan.loanType,
          principal: input.loan.principal,
          remainingPrincipal: loanBalance,
          annualRate: input.loan.annualRate,
          months: input.loan.months,
          startDate: input.loan.startDate,
          monthlyPayment: loanPayment,
          insuranceMonthly: input.loan.insuranceMonthly,
          totalInterest,
          totalInsurance: round2(input.loan.insuranceMonthly * amortization.length),
          interestPaid,
          principalRepaid,
          endDate: amortization[amortization.length - 1]?.date ?? input.loan.startDate,
        };
  const metrics = computePropertyMetrics({
    purchasePrice: input.purchasePrice,
    notaryFees: input.notaryFees,
    agencyFees: input.agencyFees,
    initialWorks: input.initialWorks,
    currentValue: input.currentValue,
    monthlyIncome: input.rentMonthly,
    monthlyExpenses: input.expensesMonthly,
    loanPayment,
    loanInsurance: input.loan?.insuranceMonthly ?? 0,
    loanBalance,
    principalRepaid,
    interestPaid,
    occupancyRate: input.occupancyRate,
  });
  return {
    accountId: input.accountId,
    name: input.name,
    kind: input.kind,
    address: input.address,
    purchaseDate: input.purchaseDate,
    purchasePrice: input.purchasePrice,
    notaryFees: input.notaryFees,
    agencyFees: input.agencyFees,
    initialWorks: input.initialWorks,
    surfaceM2: input.surfaceM2,
    currentValue: input.currentValue,
    notes: input.notes,
    loan,
    cashFlows: input.cashFlows.map((cashFlow, index) => ({
      ...cashFlow,
      id: `${input.accountId}-cf-${index + 1}`,
    })),
    appreciationHistory: APPRECIATION_NOTES[input.accountId] ?? [],
    metrics,
    amortization,
  };
}

export function buildProperties(now: Date = new Date()): PropertyDto[] {
  return PROPERTY_INPUTS.map((input) => buildProperty(input, now));
}

export function propertyEquityEur(accountId: string, now: Date = new Date()): number {
  const property = buildProperties(now).find((item) => item.accountId === accountId);
  return property?.metrics.equity ?? 0;
}

export function realEstateEquityEur(now: Date = new Date()): number {
  return round2(buildProperties(now).reduce((sum, property) => sum + property.metrics.equity, 0));
}
