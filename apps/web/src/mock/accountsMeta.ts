/**
 * Métadonnées des comptes et établissements utilisés par la maquette.
 * Séparé des valeurs pour éviter toute dépendance circulaire.
 */
import { PROVIDER_LABELS, TYPE_LABELS, providerName as providerLabel } from '../lib/labels.ts';

export type AccountKind = 'CASH' | 'SAVINGS' | 'INVESTMENT' | 'CRYPTO' | 'REAL_ESTATE';

export interface AccountMeta {
  readonly id: string;
  readonly name: string;
  readonly type: AccountKind;
  readonly providerId: string;
  readonly currency: string;
  readonly externalAccountId: string | null;
  readonly isActive: boolean;
}

export const PROVIDERS: readonly { readonly id: string; readonly name: string }[] = Object.entries(PROVIDER_LABELS).map(
  ([id, name]) => ({ id, name }),
);

export function providerName(providerId: string): string {
  return providerLabel(providerId);
}

export { TYPE_LABELS };

export const ACCOUNT_META: readonly AccountMeta[] = [
  {
    id: 'acc-ca-courant',
    name: 'Compte courant Crédit Agricole',
    type: 'CASH',
    providerId: 'credit-agricole',
    currency: 'EUR',
    externalAccountId: 'FR7612345678901234567890123',
    isActive: true,
  },
  {
    id: 'acc-ca-livret',
    name: 'Livret A',
    type: 'SAVINGS',
    providerId: 'credit-agricole',
    currency: 'EUR',
    externalAccountId: 'FR7698765432109876543210987',
    isActive: true,
  },
  {
    id: 'acc-ca-pel',
    name: 'PEL 2019',
    type: 'SAVINGS',
    providerId: 'credit-agricole',
    currency: 'EUR',
    externalAccountId: 'FR7611112222333344445555666',
    isActive: true,
  },
  {
    id: 'acc-rev-usd',
    name: 'Revolut — compte USD',
    type: 'CASH',
    providerId: 'revolut',
    currency: 'USD',
    externalAccountId: 'REV-US-8842011',
    isActive: true,
  },
  {
    id: 'acc-degiro-cto',
    name: 'Compte-titres DEGIRO',
    type: 'INVESTMENT',
    providerId: 'degiro',
    currency: 'EUR',
    externalAccountId: 'DEG-4471902',
    isActive: true,
  },
  {
    id: 'acc-tr-pea',
    name: 'PEA Trade Republic',
    type: 'INVESTMENT',
    providerId: 'trade-republic',
    currency: 'EUR',
    externalAccountId: 'TR-PEA-77104',
    isActive: true,
  },
  {
    id: 'acc-tr-cto',
    name: 'Compte-titres Trade Republic',
    type: 'INVESTMENT',
    providerId: 'trade-republic',
    currency: 'USD',
    externalAccountId: 'TR-CTO-77105',
    isActive: true,
  },
  {
    id: 'acc-mm-main',
    name: 'MetaMask — portefeuille principal',
    type: 'CRYPTO',
    providerId: 'metamask',
    currency: 'EUR',
    externalAccountId: '0x7a4F1c9b2D8e5A6f03B1C4d9E7a2F5b8C1d3E6a9',
    isActive: true,
  },
  {
    id: 'acc-mm-cold',
    name: 'MetaMask — réserve stablecoins',
    type: 'CRYPTO',
    providerId: 'metamask',
    currency: 'EUR',
    externalAccountId: '0x1B2c3D4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B0c',
    isActive: true,
  },
  {
    id: 'acc-divers',
    name: 'Or physique & objets de valeur',
    type: 'SAVINGS',
    providerId: 'autres',
    currency: 'EUR',
    externalAccountId: null,
    isActive: true,
  },
  {
    id: 'acc-re-lyon',
    name: 'Appartement Lyon 3e',
    type: 'REAL_ESTATE',
    providerId: 'autres',
    currency: 'EUR',
    externalAccountId: null,
    isActive: true,
  },
  {
    id: 'acc-re-nantes',
    name: 'Studio Nantes',
    type: 'REAL_ESTATE',
    providerId: 'autres',
    currency: 'EUR',
    externalAccountId: null,
    isActive: true,
  },
];

export function accountMeta(accountId: string): AccountMeta | null {
  return ACCOUNT_META.find((account) => account.id === accountId) ?? null;
}

export function accountName(accountId: string): string {
  return accountMeta(accountId)?.name ?? 'Compte inconnu';
}

/** Taux de change approximatifs de la maquette (1 unité de devise = x EUR). */
export const FX_TO_EUR: Readonly<Record<string, number>> = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.04,
};

export function toEur(amount: number, currency: string): number | null {
  const rate = FX_TO_EUR[currency.toUpperCase()];
  return rate === undefined ? null : amount * rate;
}
