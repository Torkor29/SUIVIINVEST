/**
 * Portefeuille saisi à la main, en mode démonstration : lignes, courbes de cours
 * (marche aléatoire déterministe qui aboutit au dernier cours connu), achats
 * programmés et recherche d'actifs.
 */
import type {
  AssetSearchResponse,
  DcaPlanDto,
  HoldingDetailResponse,
  HoldingKind,
  HoldingOperationDto,
  HoldingPositionDto,
  HoldingsHistoryResponse,
  HoldingsResponse,
  HoldingValuePoint,
  PeriodKey,
} from '@suiviinvest/api-contract';
import { accountName, toEur } from './accountsMeta.ts';
import { RAW_POSITIONS } from './holdings.ts';
import { mulberry32, round2, seedFrom } from './random.ts';

const TODAY = '2026-09-21';
const HISTORY_DAYS = 5 * 365;
const KIND_LABELS: Readonly<Record<HoldingKind, string>> = {
  EQUITY: 'Action',
  ETF: 'ETF',
  FUND: 'Fonds',
  BOND: 'Obligation',
  CRYPTO: 'Crypto',
  OTHER: 'Autre',
};

interface DemoAsset {
  readonly instrumentId: string;
  readonly symbol: string;
  readonly isin: string | null;
  readonly name: string;
  readonly kind: HoldingKind;
  readonly exchange: string | null;
  readonly quantity: number;
  readonly averageCostEur: number;
  readonly lastPriceEur: number;
  readonly accounts: readonly string[];
  readonly editable: boolean;
  readonly quoteCurrency: string;
}

const ASSETS: readonly DemoAsset[] = [
  ...RAW_POSITIONS.map((raw) => ({
    instrumentId: raw.instrumentId,
    symbol: raw.symbol,
    isin: raw.isin,
    name: raw.name,
    kind: (raw.kind === 'STOCK' ? 'EQUITY' : raw.kind) as HoldingKind,
    exchange: raw.currency === 'USD' ? 'NASDAQ' : 'Euronext Paris',
    quantity: raw.quantity,
    averageCostEur: round2(toEur(raw.averageCost, raw.currency) ?? raw.averageCost),
    lastPriceEur: round2(toEur(raw.lastPrice, raw.currency) ?? raw.lastPrice),
    accounts: [accountName(raw.accountId)],
    editable: false,
    quoteCurrency: raw.currency,
  })),
  {
    instrumentId: 'ins-nvda',
    symbol: 'NVDA',
    isin: 'US67066G1040',
    name: 'NVIDIA Corporation',
    kind: 'EQUITY',
    exchange: 'NASDAQ',
    quantity: 14.2381,
    averageCostEur: 101.4,
    lastPriceEur: 162.8,
    accounts: ['Mes investissements'],
    editable: true,
    quoteCurrency: 'USD',
  },
  {
    instrumentId: 'ins-btc',
    symbol: 'BTC',
    isin: null,
    name: 'Bitcoin',
    kind: 'CRYPTO',
    exchange: null,
    quantity: 0.0842,
    averageCostEur: 51_200,
    lastPriceEur: 97_450,
    accounts: ['Mes cryptos'],
    editable: true,
    quoteCurrency: 'EUR',
  },
  {
    instrumentId: 'ins-oat',
    symbol: 'OAT34',
    isin: 'FR001400NEF3',
    name: 'OAT 3 % 25 novembre 2034',
    kind: 'BOND',
    exchange: null,
    quantity: 20,
    averageCostEur: 97.6,
    lastPriceEur: 99.1,
    accounts: ['Mes investissements'],
    editable: true,
    quoteCurrency: 'EUR',
  },
];

const PLAN: DcaPlanDto = {
  id: 'plan-nvda',
  instrumentId: 'ins-nvda',
  assetName: 'NVIDIA Corporation',
  assetSymbol: 'NVDA',
  amount: 200,
  currency: 'USD',
  frequency: 'MONTHLY',
  dayOfMonth: 10,
  startDate: '2025-10-10',
  endDate: null,
  fees: 0,
  active: true,
  executions: 12,
  investedEur: 2208,
  quantity: 14.2381,
  nextDate: '2026-10-10',
  pending: 0,
};

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Cours quotidiens sur 5 ans qui aboutissent exactement au dernier cours. */
function priceSeries(asset: DemoAsset): { date: string; total: number }[] {
  const random = mulberry32(seedFrom(asset.instrumentId));
  const volatility = asset.kind === 'CRYPTO' ? 0.035 : asset.kind === 'BOND' ? 0.002 : 0.014;
  const drift = asset.kind === 'BOND' ? 0 : 0.0004;
  const raw: number[] = [1];
  for (let index = 1; index < HISTORY_DAYS; index += 1) {
    const shock = (random() - 0.5) * 2 * volatility;
    raw.push((raw[index - 1] as number) * (1 + drift + shock));
  }
  const scale = asset.lastPriceEur / (raw[raw.length - 1] as number);
  return raw.map((value, index) => ({
    date: shiftDay(TODAY, index - (HISTORY_DAYS - 1)),
    total: round2(value * scale),
  }));
}

function periodStart(period: PeriodKey): string {
  const days: Partial<Record<PeriodKey, number>> = { '1D': 1, '1W': 7, '1M': 30, '3M': 91, '1Y': 365, '5Y': 5 * 365 };
  if (period === 'YTD') return `${TODAY.slice(0, 4)}-01-01`;
  if (period === 'MAX') return '1970-01-01';
  return shiftDay(TODAY, -(days[period] ?? 365));
}

function position(asset: DemoAsset): HoldingPositionDto {
  const series = priceSeries(asset);
  const value = round2(asset.quantity * asset.lastPriceEur);
  const invested = round2(asset.quantity * asset.averageCostEur);
  const previous = series[series.length - 2]?.total ?? asset.lastPriceEur;
  return {
    instrumentId: asset.instrumentId,
    name: asset.name,
    symbol: asset.symbol,
    isin: asset.isin,
    kind: asset.kind,
    kindLabel: KIND_LABELS[asset.kind],
    exchange: asset.exchange,
    priceSource: asset.kind === 'BOND' ? 'manual' : asset.kind === 'CRYPTO' ? 'coingecko' : 'yahoo',
    priceSymbol: asset.symbol,
    quoteCurrency: asset.quoteCurrency,
    quantity: asset.quantity,
    lastPrice: asset.lastPriceEur,
    priceDate: TODAY,
    value,
    invested,
    pnl: round2(value - invested),
    pnlPercent: invested > 0 ? round2(((value - invested) / invested) * 100) : 0,
    realizedPnl: 0,
    dayChangePercent: round2(((asset.lastPriceEur - previous) / previous) * 100),
    weightPercent: 0,
    editable: asset.editable,
    accounts: asset.accounts,
    sparkline: series.slice(-30).map((point) => point.total),
  };
}

export function holdingsOverview(): HoldingsResponse {
  const positions = ASSETS.map(position).sort((a, b) => b.value - a.value);
  const value = round2(positions.reduce((total, item) => total + item.value, 0));
  const invested = round2(positions.reduce((total, item) => total + item.invested, 0));
  const weighted = positions.map((item) => ({ ...item, weightPercent: round2((item.value / value) * 100) }));
  const dayChange = round2(
    positions.reduce((total, item) => total + item.value - item.value / (1 + (item.dayChangePercent ?? 0) / 100), 0),
  );
  const byKind = new Map<string, number>();
  for (const item of positions) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + item.value);
  return {
    totals: {
      value,
      invested,
      pnl: round2(value - invested),
      pnlPercent: round2(((value - invested) / invested) * 100),
      realizedPnl: 408.7,
      dayChange,
      dayChangePercent: round2((dayChange / (value - dayChange)) * 100),
    },
    positions: weighted,
    plans: [PLAN],
    allocation: [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, amount]) => ({
        key: kind,
        label: KIND_LABELS[kind as HoldingKind],
        value: round2(amount),
        percent: round2((amount / value) * 100),
      })),
    lastPriceUpdate: new Date(Date.now() - 42 * 60_000).toISOString(),
    warnings: [],
  };
}

/** Valeur et investi : versements réguliers, valeur qui suit les cours. */
function valueHistory(assets: readonly DemoAsset[], from: string): HoldingValuePoint[] {
  const series = assets.map((asset) => ({ asset, prices: priceSeries(asset) }));
  const dates = (series[0]?.prices ?? []).map((point) => point.date);
  const points: HoldingValuePoint[] = [];
  dates.forEach((date, index) => {
    if (date < from) return;
    // Montée progressive des quantités sur l'historique (achats étalés).
    const progress = Math.min(1, 0.25 + (0.75 * index) / (dates.length - 1));
    let value = 0;
    let invested = 0;
    for (const { asset, prices } of series) {
      const quantity = asset.quantity * progress;
      value += quantity * (prices[index]?.total ?? asset.lastPriceEur);
      invested += quantity * asset.averageCostEur;
    }
    points.push({ date, value: round2(value), invested: round2(invested) });
  });
  return points;
}

export function holdingsHistory(period: PeriodKey): HoldingsHistoryResponse {
  const points = valueHistory(ASSETS, periodStart(period));
  const start = points[0];
  const end = points[points.length - 1];
  const change = start && end ? round2(end.value - start.value - (end.invested - start.invested)) : 0;
  return { period, points, change, changePercent: start ? round2((change / start.value) * 100) : 0 };
}

export function holdingDetail(instrumentId: string, period: PeriodKey): HoldingDetailResponse | null {
  const asset = ASSETS.find((item) => item.instrumentId === instrumentId);
  if (!asset) return null;
  const from = periodStart(period);
  const prices = priceSeries(asset).filter((point) => point.date >= from);
  const first = prices[0]?.total ?? asset.lastPriceEur;
  const dto = position(asset);
  const operations: HoldingOperationDto[] = asset.instrumentId === 'ins-nvda'
    ? Array.from({ length: 12 }, (_, index) => {
        const date = shiftDay('2026-09-10', -30 * index);
        const unitPrice = round2(asset.lastPriceEur * (0.62 + 0.03 * (12 - index)));
        return {
          id: `op-nvda-${index}`,
          date,
          type: 'BUY',
          typeLabel: 'Achat programmé',
          quantity: round2((184 / unitPrice) * 10_000) / 10_000,
          unitPrice,
          amount: -184,
          fees: 0,
          accountName: 'Mes investissements',
          planId: PLAN.id,
          deletable: true,
          description: 'Investissement programmé NVIDIA Corporation',
        };
      })
    : [
        {
          id: `op-${asset.instrumentId}`,
          date: '2024-03-12',
          type: 'BUY',
          typeLabel: 'Achat',
          quantity: asset.quantity,
          unitPrice: asset.averageCostEur,
          amount: -round2(asset.quantity * asset.averageCostEur),
          fees: 0,
          accountName: asset.accounts[0] ?? 'Mes investissements',
          planId: null,
          deletable: asset.editable,
          description: null,
        },
      ];
  return {
    asset: {
      instrumentId: dto.instrumentId,
      name: dto.name,
      symbol: dto.symbol,
      isin: dto.isin,
      kind: dto.kind,
      kindLabel: dto.kindLabel,
      exchange: dto.exchange,
      priceSource: dto.priceSource,
      priceSymbol: dto.priceSymbol,
      quoteCurrency: dto.quoteCurrency,
    },
    position: dto,
    operations,
    plans: asset.instrumentId === PLAN.instrumentId ? [PLAN] : [],
    prices,
    history: valueHistory([asset], from),
    period,
    priceChangePercent: round2(((asset.lastPriceEur - first) / first) * 100),
  };
}

export function assetSearch(query: string): AssetSearchResponse {
  const q = query.trim().toLowerCase();
  const catalog = [
    { source: 'yahoo' as const, priceSymbol: 'NVDA', symbol: 'NVDA', name: 'NVIDIA Corporation', kind: 'EQUITY' as const, exchange: 'NASDAQ', typeLabel: 'Action', isin: null },
    { source: 'yahoo' as const, priceSymbol: 'AAPL', symbol: 'AAPL', name: 'Apple Inc.', kind: 'EQUITY' as const, exchange: 'NASDAQ', typeLabel: 'Action', isin: null },
    { source: 'yahoo' as const, priceSymbol: 'AI.PA', symbol: 'AI.PA', name: 'Air Liquide', kind: 'EQUITY' as const, exchange: 'Paris', typeLabel: 'Action', isin: null },
    { source: 'yahoo' as const, priceSymbol: 'CW8.PA', symbol: 'CW8.PA', name: 'Amundi MSCI World', kind: 'ETF' as const, exchange: 'Paris', typeLabel: 'ETF', isin: null },
    { source: 'yahoo' as const, priceSymbol: 'SXR8.DE', symbol: 'SXR8.DE', name: 'iShares Core S&P 500 UCITS ETF', kind: 'ETF' as const, exchange: 'XETRA', typeLabel: 'ETF', isin: null },
    { source: 'coingecko' as const, priceSymbol: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', kind: 'CRYPTO' as const, exchange: null, typeLabel: 'Crypto', isin: null },
    { source: 'coingecko' as const, priceSymbol: 'ethereum', symbol: 'ETH', name: 'Ethereum', kind: 'CRYPTO' as const, exchange: null, typeLabel: 'Crypto', isin: null },
    { source: 'coingecko' as const, priceSymbol: 'solana', symbol: 'SOL', name: 'Solana', kind: 'CRYPTO' as const, exchange: null, typeLabel: 'Crypto', isin: null },
  ];
  return {
    results: catalog.filter((item) => item.name.toLowerCase().includes(q) || item.symbol.toLowerCase().includes(q)),
    unavailable: [],
  };
}

/** En démo, un actif « ajouté » renvoie la fiche existante la plus proche. */
export function demoAsset(symbol: string | undefined): HoldingDetailResponse['asset'] {
  const found = ASSETS.find((item) => item.symbol === symbol) ?? ASSETS.find((item) => item.instrumentId === 'ins-nvda');
  return (holdingDetail((found as DemoAsset).instrumentId, '1Y') as HoldingDetailResponse).asset;
}
