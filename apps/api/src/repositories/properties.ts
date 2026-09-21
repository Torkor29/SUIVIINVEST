import type { PropertyCashFlowCategory, PropertyCashFlowEntry, PropertyDetails, PropertyLoan } from '@suiviinvest/core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';

/**
 * Dépôt immobilier : bien, crédit, estimations et flux de revenus/charges.
 *
 * Le bien est rattaché à un compte de type `REAL_ESTATE` : ainsi l'immobilier
 * participe naturellement au patrimoine net (comme exigé) sans table parallèle
 * de valorisation.
 */

export interface UpsertPropertyInput {
  readonly accountId: string;
  readonly name: string;
  readonly kind: string;
  readonly address?: string | null;
  readonly purchaseDate?: string | null;
  readonly purchasePrice: number;
  readonly notaryFees?: number;
  readonly agencyFees?: number;
  readonly initialWorks?: number;
  readonly surfaceM2?: number | null;
  readonly currentValue: number;
  readonly notes?: string | null;
}

export interface UpsertLoanInput {
  readonly loanType: 'AMORTIZABLE' | 'IN_FINE' | 'VARIABLE' | 'OTHER';
  readonly principal: number;
  readonly remainingPrincipal?: number;
  readonly annualRate: number;
  readonly months: number;
  readonly startDate: string;
  readonly monthlyPayment?: number;
  readonly insuranceMonthly?: number;
  readonly interestPaid?: number;
  readonly principalRepaid?: number;
}

export interface CashFlowInput {
  readonly direction: 'INCOME' | 'EXPENSE';
  readonly category: PropertyCashFlowCategory;
  readonly label: string;
  readonly amount: number;
  readonly currency: string;
  readonly date: string;
  readonly recurrence: 'ONE_OFF' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  readonly received?: boolean;
}

export class PropertyRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  upsert(input: UpsertPropertyInput): void {
    this.#db.run(
      `INSERT INTO properties (account_id, name, kind, address, purchase_date, purchase_price,
         notary_fees, agency_fees, initial_works, surface_m2, current_value, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         address = excluded.address, purchase_date = excluded.purchase_date,
         purchase_price = excluded.purchase_price, notary_fees = excluded.notary_fees,
         agency_fees = excluded.agency_fees, initial_works = excluded.initial_works,
         surface_m2 = excluded.surface_m2, current_value = excluded.current_value,
         notes = excluded.notes, updated_at = excluded.updated_at`,
      input.accountId,
      input.name,
      input.kind,
      input.address ?? null,
      input.purchaseDate ?? null,
      input.purchasePrice,
      input.notaryFees ?? 0,
      input.agencyFees ?? 0,
      input.initialWorks ?? 0,
      input.surfaceM2 ?? null,
      input.currentValue,
      input.notes ?? null,
      new Date().toISOString(),
    );
  }

  delete(accountId: string): void {
    this.#db.run('DELETE FROM properties WHERE account_id = ?', accountId);
  }

  upsertLoan(accountId: string, loan: UpsertLoanInput): void {
    this.#db.run(
      `INSERT INTO property_loans (account_id, loan_type, principal, remaining_principal, annual_rate,
         months, start_date, monthly_payment, insurance_monthly, interest_paid, principal_repaid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET loan_type = excluded.loan_type,
         principal = excluded.principal, remaining_principal = excluded.remaining_principal,
         annual_rate = excluded.annual_rate, months = excluded.months, start_date = excluded.start_date,
         monthly_payment = excluded.monthly_payment, insurance_monthly = excluded.insurance_monthly,
         interest_paid = excluded.interest_paid, principal_repaid = excluded.principal_repaid`,
      accountId,
      loan.loanType,
      loan.principal,
      // 0 = « non communiqué » : le capital restant dû est alors recalculé depuis
      // l'échéancier plutôt que figé au capital initial.
      loan.remainingPrincipal ?? 0,
      loan.annualRate,
      loan.months,
      loan.startDate,
      loan.monthlyPayment ?? 0,
      loan.insuranceMonthly ?? 0,
      loan.interestPaid ?? 0,
      loan.principalRepaid ?? 0,
    );
  }

  deleteLoan(accountId: string): void {
    this.#db.run('DELETE FROM property_loans WHERE account_id = ?', accountId);
  }

  addAppraisal(accountId: string, date: string, value: number, note?: string | null): void {
    this.#db.run(
      'INSERT INTO property_appraisals (id, account_id, date, value, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      accountId,
      date,
      value,
      note ?? null,
      new Date().toISOString(),
    );
  }

  addCashFlow(accountId: string, input: CashFlowInput): string {
    const id = randomUUID();
    this.#db.run(
      `INSERT INTO property_cash_flows (id, account_id, direction, category, label, amount, currency,
         date, recurrence, received, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      accountId,
      input.direction,
      input.category,
      input.label,
      input.amount,
      input.currency,
      input.date,
      input.recurrence,
      input.received === false ? 0 : 1,
      new Date().toISOString(),
    );
    return id;
  }

  deleteCashFlow(accountId: string, cashFlowId: string): boolean {
    const existing = this.#db.get<{ id: string }>(
      'SELECT id FROM property_cash_flows WHERE id = ? AND account_id = ?',
      cashFlowId,
      accountId,
    );
    if (!existing) return false;
    this.#db.run('DELETE FROM property_cash_flows WHERE id = ?', cashFlowId);
    return true;
  }

  /** Charge un bien complet (détails, crédit, estimations, flux) prêt pour le calcul. */
  load(accountId: string): {
    details: PropertyDetails;
    cashFlows: PropertyCashFlowEntry[];
  } | null {
    const property = this.#db.get<{
      account_id: string;
      name: string;
      kind: string;
      address: string | null;
      purchase_date: string | null;
      purchase_price: number;
      notary_fees: number;
      agency_fees: number;
      initial_works: number;
      surface_m2: number | null;
      current_value: number;
      notes: string | null;
    }>('SELECT * FROM properties WHERE account_id = ?', accountId);
    if (!property) return null;

    const loanRow = this.#db.get<{
      loan_type: PropertyLoan['loanType'];
      principal: number;
      remaining_principal: number;
      annual_rate: number;
      months: number;
      start_date: string;
      monthly_payment: number;
      insurance_monthly: number;
      interest_paid: number;
      principal_repaid: number;
    }>('SELECT * FROM property_loans WHERE account_id = ?', accountId);

    const appraisals = this.#db.all<{ date: string; value: number; note: string | null }>(
      'SELECT date, value, note FROM property_appraisals WHERE account_id = ? ORDER BY date',
      accountId,
    );

    const cashFlowRows = this.#db.all<{
      id: string;
      direction: 'INCOME' | 'EXPENSE';
      category: PropertyCashFlowCategory;
      label: string;
      amount: number;
      currency: string;
      date: string;
      recurrence: PropertyCashFlowEntry['recurrence'];
      received: number;
    }>('SELECT * FROM property_cash_flows WHERE account_id = ? ORDER BY date', accountId);

    const loan: PropertyLoan | null = loanRow
      ? {
          loanType: loanRow.loan_type,
          principal: loanRow.principal,
          remainingPrincipal: loanRow.remaining_principal,
          annualRate: loanRow.annual_rate,
          months: loanRow.months,
          startDate: loanRow.start_date,
          monthlyPayment: loanRow.monthly_payment,
          insuranceMonthly: loanRow.insurance_monthly,
          interestPaid: loanRow.interest_paid,
          principalRepaid: loanRow.principal_repaid,
        }
      : null;

    return {
      details: {
        id: property.account_id,
        accountId: property.account_id,
        name: property.name,
        kind: property.kind,
        address: property.address,
        purchaseDate: property.purchase_date,
        purchasePrice: property.purchase_price,
        notaryFees: property.notary_fees,
        agencyFees: property.agency_fees,
        initialWorks: property.initial_works,
        surfaceM2: property.surface_m2,
        currentValue: property.current_value,
        appreciationHistory: appraisals.map((row) => ({ date: row.date, value: row.value, note: row.note })),
        notes: property.notes,
        loan,
      },
      cashFlows: cashFlowRows.map((row) => ({
        id: row.id,
        accountId,
        direction: row.direction,
        category: row.category,
        label: row.label,
        amount: row.amount,
        currency: row.currency,
        date: row.date,
        recurrence: row.recurrence,
        received: row.received === 1,
      })),
    };
  }

  listAccountIds(): string[] {
    return this.#db.all<{ account_id: string }>('SELECT account_id FROM properties').map((row) => row.account_id);
  }

  count(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM properties')?.count ?? 0;
  }
}