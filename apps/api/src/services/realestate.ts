import {
  amortizationSchedule,
  computePropertyMetrics,
  monthlyPropertyCashFlow,
  round,
  sum,
} from '@suiviinvest/core';
import type { PropertyDto, RealEstateResponse } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository } from '../repositories/accounts.ts';
import { PropertyRepository } from '../repositories/properties.ts';

/**
 * Service immobilier : traduit le dépôt en DTO complets (bien + crédit + flux +
 * indicateurs) prêts pour l'interface.
 *
 * Les indicateurs viennent de `@suiviinvest/core` : aucune formule n'est
 * dupliquée ici, donc l'API et les tests utilisent exactement le même calcul.
 */
export class RealEstateService {
  readonly #properties: PropertyRepository;
  readonly #accounts: AccountRepository;

  constructor(db: Db) {
    this.#properties = new PropertyRepository(db);
    this.#accounts = new AccountRepository(db);
  }

  list(): RealEstateResponse {
    const accountIds = this.#properties.listAccountIds();
    const properties: PropertyDto[] = [];

    for (const accountId of accountIds) {
      const dto = this.get(accountId);
      if (dto) properties.push(dto);
    }

    const totals = {
      currentValue: round(sum(properties.map((p) => p.currentValue))),
      loanBalance: round(sum(properties.map((p) => p.metrics.loanBalance))),
      equity: round(sum(properties.map((p) => p.metrics.equity))),
      annualIncome: round(sum(properties.map((p) => p.metrics.annualIncome))),
      annualExpenses: round(sum(properties.map((p) => p.metrics.annualExpenses))),
      annualCashFlowAfterLoan: round(sum(properties.map((p) => p.metrics.annualCashFlowAfterLoan))),
      interestPaid: round(sum(properties.map((p) => p.metrics.interestPaid))),
      unrealizedGain: round(sum(properties.map((p) => p.metrics.unrealizedGain))),
    };

    return {
      properties: properties.sort((a, b) => b.currentValue - a.currentValue),
      totals,
      portfolio: {
        grossYield: totals.currentValue > 0 ? round((totals.annualIncome / totals.currentValue) * 100, 4) : 0,
        netYield: totals.currentValue > 0 ? round((totals.annualCashFlowAfterLoan / totals.currentValue) * 100, 4) : 0,
        monthlyCashFlow: round(totals.annualCashFlowAfterLoan / 12),
      },
    };
  }

  get(accountId: string): PropertyDto | null {
    const loaded = this.#properties.load(accountId);
    if (!loaded) return null;
    const { details, cashFlows } = loaded;
    const metrics = computePropertyMetrics({ property: details, cashFlows, asOf: today() });
    const schedule = details.loan
      ? amortizationSchedule({
          principal: details.loan.principal,
          annualRate: details.loan.annualRate,
          months: details.loan.months,
          startDate: details.loan.startDate,
          insuranceMonthly: details.loan.insuranceMonthly,
          monthlyPayment: details.loan.monthlyPayment,
          asOf: today(),
        })
      : null;

    const currentMonth = monthlyPropertyCashFlow(details, cashFlows, today().slice(0, 7));

    return {
      accountId,
      name: details.name,
      kind: details.kind,
      address: details.address,
      purchaseDate: details.purchaseDate,
      purchasePrice: details.purchasePrice,
      notaryFees: details.notaryFees,
      agencyFees: details.agencyFees,
      initialWorks: details.initialWorks,
      surfaceM2: details.surfaceM2,
      currentValue: details.currentValue,
      notes: details.notes,
      loan: details.loan
        ? {
            loanType: details.loan.loanType,
            principal: details.loan.principal,
            remainingPrincipal: schedule ? schedule.remainingPrincipal : details.loan.remainingPrincipal,
            annualRate: details.loan.annualRate,
            months: details.loan.months,
            startDate: details.loan.startDate,
            monthlyPayment: schedule ? schedule.monthlyPayment : details.loan.monthlyPayment,
            insuranceMonthly: details.loan.insuranceMonthly,
            totalInterest: schedule ? schedule.totalInterest : 0,
            totalInsurance: schedule ? schedule.totalInsurance : 0,
            interestPaid: schedule ? schedule.interestPaidToDate : details.loan.interestPaid,
            principalRepaid: schedule ? schedule.principalRepaidToDate : details.loan.principalRepaid,
            endDate: schedule ? schedule.endDate : details.loan.startDate,
          }
        : null,
      cashFlows: cashFlows.map((entry) => ({ ...entry })),
      appreciationHistory: details.appreciationHistory.map((entry) => ({ ...entry })),
      metrics: {
        totalCost: metrics.totalCost,
        equity: metrics.equity,
        loanBalance: metrics.loanBalance,
        grossYield: metrics.grossYield,
        netYield: metrics.netYield,
        yieldOnEquity: metrics.yieldOnEquity,
        downPayment: metrics.downPayment,
        monthlyIncome: currentMonth.income || metrics.monthlyIncome,
        monthlyExpenses: currentMonth.expenses || metrics.monthlyExpenses,
        monthlyCashFlow: metrics.monthlyCashFlow,
        monthlyCashFlowAfterLoan: currentMonth.net || metrics.monthlyCashFlowAfterLoan,
        annualIncome: metrics.annualIncome,
        annualExpenses: metrics.annualExpenses,
        annualCashFlow: metrics.annualCashFlow,
        annualCashFlowAfterLoan: metrics.annualCashFlowAfterLoan,
        unrealizedGain: metrics.unrealizedGain,
        principalRepaid: metrics.principalRepaid,
        interestPaid: metrics.interestPaid,
        occupancyRate: metrics.occupancyRate,
      },
      amortization: (schedule?.rows ?? []).slice(0, 480).map((row) => ({ ...row })),
    };
  }

  /** Crée le compte de type REAL_ESTATE rattaché au bien (s'il n'existe pas). */
  ensureAccount(input: {
    accountId?: string;
    name: string;
    currency: string;
    externalAccountId?: string | null;
  }): string {
    if (input.accountId) {
      const existing = this.#accounts.get(input.accountId);
      if (existing) return existing.id;
    }
    const account = this.#accounts.create({
      name: input.name,
      type: 'REAL_ESTATE',
      providerId: 'manual',
      currency: input.currency,
      externalAccountId: input.externalAccountId ?? null,
    });
    return account.id;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}