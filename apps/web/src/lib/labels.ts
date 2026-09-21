/** Libellés métier partagés (types de comptes, établissements, types d'opérations). */

export const TYPE_LABELS: Readonly<Record<string, string>> = {
  CASH: 'Comptes courants',
  SAVINGS: 'Épargne',
  INVESTMENT: 'Investissements',
  CRYPTO: 'Crypto',
  REAL_ESTATE: 'Immobilier',
};

export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  'credit-agricole': 'Crédit Agricole',
  degiro: 'DEGIRO',
  'trade-republic': 'Trade Republic',
  revolut: 'Revolut',
  metamask: 'MetaMask',
  autres: 'Autres',
};

export const TRANSACTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  BUY: 'Achat',
  SELL: 'Vente',
  DIVIDEND: 'Dividende',
  INTEREST: 'Intérêt',
  RENT: 'Loyer',
  DEPOSIT: 'Dépôt',
  WITHDRAWAL: 'Retrait',
  FEE: 'Frais',
  TAX: 'Impôt',
  EXPENSE: 'Dépense',
  LOAN_PAYMENT: 'Échéance de crédit',
};

export function providerName(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? 'Autres';
}

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

export function transactionTypeLabel(type: string): string {
  return TRANSACTION_TYPE_LABELS[type] ?? type;
}
