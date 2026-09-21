import type { AccountSummary } from '@suiviinvest/api-contract';

export interface TransactionFilterValues {
  readonly search: string;
  readonly accountId: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly minAmount: string;
  readonly maxAmount: string;
}

export interface TransactionFiltersProps {
  readonly values: TransactionFilterValues;
  readonly accounts: readonly AccountSummary[];
  readonly onChange: (values: TransactionFilterValues) => void;
  readonly onReset: () => void;
}

const TYPES: readonly string[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'INTEREST',
  'RENT',
  'DEPOSIT',
  'WITHDRAWAL',
  'FEE',
  'TAX',
  'EXPENSE',
  'LOAN_PAYMENT',
];

/** Barre de filtres de l'historique des transactions. */
export function TransactionFilters({ values, accounts, onChange, onReset }: TransactionFiltersProps) {
  const update = (patch: Partial<TransactionFilterValues>): void => onChange({ ...values, ...patch });
  return (
    <div className="filters">
      <label className="field field-grow">
        <span className="field-label">Recherche</span>
        <input
          className="input"
          type="search"
          placeholder="Libellé, ISIN, compte…"
          value={values.search}
          onChange={(event) => update({ search: event.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">Compte</span>
        <select className="input" value={values.accountId} onChange={(event) => update({ accountId: event.target.value })}>
          <option value="">Tous</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Type</span>
        <select className="input" value={values.type} onChange={(event) => update({ type: event.target.value })}>
          <option value="">Tous</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Du</span>
        <input className="input" type="date" value={values.from} onChange={(event) => update({ from: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Au</span>
        <input className="input" type="date" value={values.to} onChange={(event) => update({ to: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Montant min. (€)</span>
        <input className="input" type="number" value={values.minAmount} onChange={(event) => update({ minAmount: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Montant max. (€)</span>
        <input className="input" type="number" value={values.maxAmount} onChange={(event) => update({ maxAmount: event.target.value })} />
      </label>
      <button type="button" className="btn btn-ghost" onClick={onReset}>
        Réinitialiser
      </button>
    </div>
  );
}
