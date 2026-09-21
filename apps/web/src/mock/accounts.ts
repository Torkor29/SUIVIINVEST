/** Comptes agrégés de la maquette (valeurs calculées à partir des positions). */
import type { AccountSummary } from '@suiviinvest/api-contract';
import { ACCOUNT_META, toEur, type AccountMeta } from './accountsMeta.ts';
import { buildPositions, positionsCostEur } from './holdings.ts';
import { buildWallets } from './crypto.ts';
import { buildProperties } from './realestate.ts';
import { buildTransactions } from './transactions.ts';
import { round2 } from './random.ts';

const BALANCES: Readonly<Record<string, number>> = {
  'acc-ca-courant': 8420.55,
  'acc-ca-livret': 22950,
  'acc-ca-pel': 49300,
  'acc-divers': 6400,
  'acc-rev-usd': 3480,
};

const CRYPTO_PNL: Readonly<Record<string, { readonly pnl: number; readonly percent: number; readonly realized: number; readonly cash: number }>> = {
  'acc-mm-main': { pnl: 1842.3, percent: 21.4, realized: 0, cash: 0 },
  'acc-mm-cold': { pnl: 1120.6, percent: 14.2, realized: 148.2, cash: 0 },
};

const CASH_BY_ACCOUNT: Readonly<Record<string, number>> = {
  'acc-degiro-cto': 618.4,
  'acc-tr-pea': 84.2,
  'acc-tr-cto': 128.9,
};

function lastActivity(accountId: string, transactions: readonly { readonly accountId: string; readonly date: string }[]): string | null {
  let latest: string | null = null;
  for (const transaction of transactions) {
    if (transaction.accountId !== accountId) continue;
    if (latest === null || transaction.date > latest) latest = transaction.date;
  }
  return latest;
}

function valueFor(meta: AccountMeta): { value: number; pnl: number; percent: number; realized: number } {
  if (meta.type === 'INVESTMENT') {
    const positions = buildPositions().filter((position) => position.accountId === meta.id);
    const value = round2(positions.reduce((sum, position) => sum + position.marketValueEur, 0));
    const cost = positionsCostEur(meta.id);
    const pnl = round2(value - cost);
    return { value, pnl, percent: cost === 0 ? 0 : round2((pnl / cost) * 100), realized: round2(positions.reduce((sum, position) => sum + position.realizedPnl, 0)) };
  }
  if (meta.type === 'CRYPTO') {
    const wallet = buildWallets().find((item) => item.accountId === meta.id);
    const extra = CRYPTO_PNL[meta.id];
    return { value: wallet?.valueEur ?? 0, pnl: extra?.pnl ?? 0, percent: extra?.percent ?? 0, realized: extra?.realized ?? 0 };
  }
  if (meta.type === 'REAL_ESTATE') {
    const property = buildProperties().find((item) => item.accountId === meta.id);
    return { value: property?.currentValue ?? 0, pnl: property?.metrics.unrealizedGain ?? 0, percent: 0, realized: 0 };
  }
  return { value: BALANCES[meta.id] ?? 0, pnl: 0, percent: 0, realized: 0 };
}

/** Liste des comptes, avec les totaux par type et par établissement. */
export function buildAccounts(now: Date = new Date()): AccountSummary[] {
  const transactions = buildTransactions(now);
  return ACCOUNT_META.map((meta) => {
    const computed = valueFor(meta);
    const currencyValue = meta.currency === 'EUR' ? computed.value : round2(computed.value / (toEur(1, meta.currency) ?? 1));
    return {
      id: meta.id,
      name: meta.name,
      type: meta.type,
      providerId: meta.providerId,
      currency: meta.currency,
      value: meta.currency === 'EUR' ? computed.value : currencyValue,
      valueCurrency: meta.currency === 'EUR' ? 'EUR' : meta.currency,
      cash: meta.type === 'CASH' || meta.type === 'SAVINGS' ? computed.value : CASH_BY_ACCOUNT[meta.id] ?? 0,
      invested: meta.type === 'INVESTMENT' || meta.type === 'CRYPTO' ? computed.value : 0,
      unrealizedPnl: computed.pnl,
      unrealizedPnlPercent: computed.percent,
      realizedPnl: computed.realized,
      lastActivityDate: lastActivity(meta.id, transactions),
      isActive: meta.isActive,
      externalAccountId: meta.externalAccountId,
    } satisfies AccountSummary;
  });
}

/** Valeur en EUR d'un compte, en tenant compte des devises étrangères. */
export function accountValueEur(account: AccountSummary): number | null {
  if (account.valueCurrency === 'EUR') return account.value;
  return toEur(account.value, account.valueCurrency);
}
