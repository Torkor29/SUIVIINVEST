/** Positions de la maquette (comptes-titres + PEA), converties en EUR le cas échéant. */
import type { PositionDto } from '@suiviinvest/api-contract';
import { accountName, toEur } from './accountsMeta.ts';
import { round2 } from './random.ts';

interface RawPosition {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly isin: string;
  readonly name: string;
  readonly kind: 'STOCK' | 'ETF' | 'FUND' | 'BOND';
  readonly accountId: string;
  readonly quantity: number;
  readonly averageCost: number;
  readonly lastPrice: number;
  readonly currency: string;
  readonly dividends: number;
  readonly fees: number;
  readonly realizedPnl: number;
  readonly priceDate: string;
}

export const RAW_POSITIONS: readonly RawPosition[] = [
  { instrumentId: 'ins-eunl', symbol: 'EUNL', isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World', kind: 'ETF', accountId: 'acc-degiro-cto', quantity: 312, averageCost: 78.4, lastPrice: 96.85, currency: 'EUR', dividends: 214.6, fees: 68.4, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-cw8', symbol: 'CW8', isin: 'LU1681043599', name: 'Amundi MSCI World', kind: 'ETF', accountId: 'acc-degiro-cto', quantity: 18, averageCost: 412.5, lastPrice: 512.19, currency: 'EUR', dividends: 0, fees: 42.1, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-pust', symbol: 'PUST', isin: 'FR0011871110', name: 'Amundi Nasdaq-100', kind: 'ETF', accountId: 'acc-degiro-cto', quantity: 42, averageCost: 21.8, lastPrice: 27.44, currency: 'EUR', dividends: 0, fees: 18.9, realizedPnl: 146.2, priceDate: '2026-09-19' },
  { instrumentId: 'ins-tte', symbol: 'TTE', isin: 'FR0000120271', name: 'TotalEnergies', kind: 'STOCK', accountId: 'acc-degiro-cto', quantity: 85, averageCost: 48.9, lastPrice: 58.62, currency: 'EUR', dividends: 402.75, fees: 24.5, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-ai', symbol: 'AI', isin: 'FR0000120073', name: 'Air Liquide', kind: 'STOCK', accountId: 'acc-degiro-cto', quantity: 24, averageCost: 152.3, lastPrice: 172.4, currency: 'EUR', dividends: 148.2, fees: 12.6, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-paeem', symbol: 'PAEEM', isin: 'FR0013412012', name: 'Amundi PEA MSCI Emerging Markets', kind: 'ETF', accountId: 'acc-tr-pea', quantity: 120, averageCost: 24.1, lastPrice: 26.72, currency: 'EUR', dividends: 0, fees: 15.4, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-mc', symbol: 'MC', isin: 'FR0000121014', name: 'LVMH', kind: 'STOCK', accountId: 'acc-tr-pea', quantity: 6, averageCost: 645, lastPrice: 612.5, currency: 'EUR', dividends: 78, fees: 9.8, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-ese', symbol: 'ESE', isin: 'FR0011550185', name: 'BNP Paribas Easy Stoxx Europe 600', kind: 'ETF', accountId: 'acc-tr-pea', quantity: 210, averageCost: 26.4, lastPrice: 31.85, currency: 'EUR', dividends: 0, fees: 11.2, realizedPnl: 0, priceDate: '2026-09-19' },
  { instrumentId: 'ins-aapl', symbol: 'AAPL', isin: 'US0378331005', name: 'Apple Inc.', kind: 'STOCK', accountId: 'acc-tr-cto', quantity: 22, averageCost: 176.4, lastPrice: 228.9, currency: 'USD', dividends: 31.4, fees: 14.3, realizedPnl: 262.5, priceDate: '2026-09-19' },
  { instrumentId: 'ins-vwce', symbol: 'VWCE', isin: 'IE00BK5BQT80', name: 'Vanguard FTSE All-World', kind: 'ETF', accountId: 'acc-tr-cto', quantity: 12, averageCost: 118.2, lastPrice: 141.3, currency: 'USD', dividends: 8.6, fees: 6.2, realizedPnl: 0, priceDate: '2026-09-19' },
];

/** Construit les DTO de positions avec les calculs habituels du backend. */
export function buildPositions(): PositionDto[] {
  const positions = RAW_POSITIONS.map((raw) => {
    const marketValue = round2(raw.quantity * raw.lastPrice);
    const marketValueEur = round2(toEur(marketValue, raw.currency) ?? marketValue);
    const costBasis = round2(raw.quantity * raw.averageCost);
    const unrealizedPnl = round2(marketValue - costBasis);
    const unrealizedPnlEur = round2(toEur(unrealizedPnl, raw.currency) ?? unrealizedPnl);
    const costBasisEur = round2(toEur(costBasis, raw.currency) ?? costBasis);
    return {
      instrumentId: raw.instrumentId,
      symbol: raw.symbol,
      isin: raw.isin,
      name: raw.name,
      kind: raw.kind,
      accountId: raw.accountId,
      accountName: accountName(raw.accountId),
      quantity: raw.quantity,
      averageCost: raw.averageCost,
      lastPrice: raw.lastPrice,
      currency: raw.currency,
      marketValue,
      marketValueEur,
      costBasis,
      unrealizedPnl,
      unrealizedPnlPercent: costBasis === 0 ? 0 : round2((unrealizedPnl / costBasis) * 100),
      realizedPnl: raw.realizedPnl,
      dividends: raw.dividends,
      fees: raw.fees,
      weightPercent: 0,
      priceDate: raw.priceDate,
      _costBasisEur: costBasisEur,
      _unrealizedPnlEur: unrealizedPnlEur,
    } satisfies PositionDto & { _costBasisEur: number; _unrealizedPnlEur: number };
  });
  const total = positions.reduce((sum, position) => sum + position.marketValueEur, 0);
  return positions.map((position) => ({
    ...position,
    weightPercent: total === 0 ? 0 : round2((position.marketValueEur / total) * 100),
  }));
}

/** Somme des positions (en EUR) pour un compte donné. */
export function positionsTotalEur(accountId: string): number {
  return round2(
    buildPositions()
      .filter((position) => position.accountId === accountId)
      .reduce((sum, position) => sum + position.marketValueEur, 0),
  );
}

export function positionsCostEur(accountId: string): number {
  return round2(
    buildPositions()
      .filter((position) => position.accountId === accountId)
      .reduce((sum, position) => sum + (toEur(position.costBasis, position.currency) ?? position.costBasis), 0),
  );
}
