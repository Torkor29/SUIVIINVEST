/** Historique de transactions généré de façon déterministe pour la maquette. */
import type { TransactionDto } from '@suiviinvest/api-contract';
import { accountName, accountMeta, providerName } from './accountsMeta.ts';
import { mulberry32, round2, seedFrom } from './random.ts';

const RNG = mulberry32(seedFrom('suiviinvest-mock'));

function iso(day: string): string {
  return day;
}

function monthKey(year: number, month: number): string {
  return `${year}-${`${month + 1}`.padStart(2, '0')}`;
}

interface TransactionSeed {
  readonly year: number;
  readonly month: number;
}

/** Construit l'historique complet (2021-01 → mois courant). */
export function buildTransactions(now: Date = new Date()): TransactionDto[] {
  const items: TransactionDto[] = [];
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();
  const seeds: TransactionSeed[] = [];
  for (let year = 2021; year <= endYear; year += 1) {
    const lastMonth = year === endYear ? endMonth : 11;
    for (let month = 0; month <= lastMonth; month += 1) seeds.push({ year, month });
  }
  let sequence = 1;
  const push = (
    seed: TransactionSeed,
    day: number,
    input: {
      type: string;
      accountId: string;
      instrumentId: string | null;
      instrumentName: string | null;
      isin: string | null;
      description: string;
      quantity: number | null;
      unitPrice: number | null;
      amount: number;
      fees: number;
      taxes: number;
    },
  ): void => {
    const meta = accountMeta(input.accountId);
    const currency = meta?.currency ?? 'EUR';
    const fx = currency === 'USD' ? 0.92 : 1;
    const date = iso(`${seed.year}-${monthKey(seed.year, seed.month).slice(5)}-${`${day}`.padStart(2, '0')}`);
    items.push({
      id: `tx-${sequence}`,
      date,
      type: input.type,
      accountId: input.accountId,
      accountName: accountName(input.accountId),
      providerId: meta?.providerId ?? 'autres',
      instrumentId: input.instrumentId,
      instrumentName: input.instrumentName,
      isin: input.isin,
      description: input.description,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      amount: round2(input.amount),
      currency,
      amountEur: round2(input.amount * fx),
      fees: round2(input.fees),
      taxes: round2(input.taxes),
      source: meta?.providerId === 'degiro' || meta?.providerId === 'trade-republic' ? 'API' : 'CSV',
    });
    sequence += 1;
  };

  for (const seed of seeds) {
    // Loyers des deux biens
    push(seed, 1, { type: 'RENT', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Loyer appartement Lyon 3e', quantity: null, unitPrice: null, amount: 1150, fees: 0, taxes: 0 });
    push(seed, 3, { type: 'RENT', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Loyer studio Nantes', quantity: null, unitPrice: null, amount: 620, fees: 0, taxes: 0 });
    // Échéances de crédit
    push(seed, 5, { type: 'LOAN_PAYMENT', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Échéance crédit immobilier Lyon', quantity: null, unitPrice: null, amount: -1014.2, fees: 38.5, taxes: 0 });
    push(seed, 5, { type: 'LOAN_PAYMENT', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Échéance crédit immobilier Nantes', quantity: null, unitPrice: null, amount: -543.6, fees: 22.4, taxes: 0 });
    // Charges de copropriété et gestion
    push(seed, 8, { type: 'EXPENSE', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Charges copropriété + assurance bailleur', quantity: null, unitPrice: null, amount: -232, fees: 0, taxes: 0 });
    // Versements mensuels sur les comptes-titres
    push(seed, 6, { type: 'DEPOSIT', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Virement vers compte-titres', quantity: null, unitPrice: null, amount: -600, fees: 0, taxes: 0 });
    push(seed, 6, { type: 'BUY', accountId: 'acc-degiro-cto', instrumentId: 'ins-eunl', instrumentName: 'iShares Core MSCI World', isin: 'IE00B4L5Y983', description: 'Achat programmé ETF World', quantity: 6, unitPrice: round2(88 + RNG() * 10), amount: 560, fees: 1, taxes: 0 });
    push(seed, 6, { type: 'BUY', accountId: 'acc-tr-pea', instrumentId: 'ins-ese', instrumentName: 'BNP Paribas Easy Stoxx Europe 600', isin: 'FR0011550185', description: 'Achat programmé PEA', quantity: 4, unitPrice: round2(27 + RNG() * 5), amount: 120, fees: 0, taxes: 0 });
    // Dividendes trimestriels
    if (seed.month % 3 === 2) {
      push(seed, 18, { type: 'DIVIDEND', accountId: 'acc-degiro-cto', instrumentId: 'ins-tte', instrumentName: 'TotalEnergies', isin: 'FR0000120271', description: 'Dividende TotalEnergies', quantity: 85, unitPrice: null, amount: 100.7, fees: 0, taxes: 12.6 });
      push(seed, 20, { type: 'DIVIDEND', accountId: 'acc-degiro-cto', instrumentId: 'ins-ai', instrumentName: 'Air Liquide', isin: 'FR0000120073', description: 'Dividende Air Liquide', quantity: 24, unitPrice: null, amount: 37.1, fees: 0, taxes: 4.6 });
    }
    // Intérêts annuels Livret A / PEL
    if (seed.month === 0) {
      push(seed, 15, { type: 'INTEREST', accountId: 'acc-ca-livret', instrumentId: null, instrumentName: null, isin: null, description: 'Intérêts Livret A', quantity: null, unitPrice: null, amount: 620.4, fees: 0, taxes: 0 });
      push(seed, 15, { type: 'INTEREST', accountId: 'acc-ca-pel', instrumentId: null, instrumentName: null, isin: null, description: 'Intérêts PEL', quantity: null, unitPrice: null, amount: 1180.6, fees: 0, taxes: 0 });
    }
    // Frais de courtage
    push(seed, 27, { type: 'FEE', accountId: 'acc-degiro-cto', instrumentId: null, instrumentName: null, isin: null, description: 'Frais de courtage', quantity: null, unitPrice: null, amount: -1.75, fees: 0, taxes: 0 });
    // Achats crypto occasionnels
    if (seed.month % 2 === 0) {
      push(seed, 22, { type: 'BUY', accountId: 'acc-mm-main', instrumentId: 'crypto-eth', instrumentName: 'Ethereum', isin: null, description: 'Achat ETH (DCA)', quantity: 0.02, unitPrice: 2950.4, amount: 59, fees: 0.9, taxes: 0 });
    }
    if (seed.month === 4) {
      push(seed, 12, { type: 'TAX', accountId: 'acc-ca-courant', instrumentId: null, instrumentName: null, isin: null, description: 'Prélèvement impôt sur revenus fonciers', quantity: null, unitPrice: null, amount: -1840, fees: 0, taxes: 0 });
    }
  }
  return items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1));
}

export function transactionTypes(items: readonly TransactionDto[]): string[] {
  return [...new Set(items.map((item) => item.type))].sort();
}

export function transactionProviderLabel(providerId: string): string {
  return providerName(providerId);
}
