import type { HoldingKind } from '@suiviinvest/api-contract';
import { onvistaHistory, onvistaResolve, onvistaSearch, type OnvistaSearchResult } from './onvista.ts';

/**
 * Cours de marché pour le portefeuille saisi à la main : recherche d'un actif,
 * historique des cours, taux de change.
 *
 * Sources gratuites, sans clé, avec repli automatique :
 *  - **Onvista** (actions, ETF, fonds) : source principale. Recherche par nom,
 *    ticker ou ISIN, cotations en euros, historique long ;
 *  - **Yahoo Finance** (actions, ETF, fonds, cryptos « BTC-EUR ») : secours.
 *    Endpoint public non contractuel, souvent limité (HTTP 429) depuis un
 *    serveur : deux hôtes sont essayés, avec une nouvelle tentative ;
 *  - **Stooq** : secours pour les actions quand Yahoo refuse ;
 *  - **CoinGecko** (cryptos) : recherche et 365 jours d'historique en euros ;
 *  - **Kraken** : secours crypto (environ 2 ans d'historique en euros) ;
 *  - **Frankfurter** (taux de la BCE) : conversion des devises vers l'euro, repli
 *    sur Yahoo (« USDEUR=X »).
 *
 * Aucune valeur n'est inventée : une source muette renvoie `null`, jamais un 0.
 */

export type PriceSource = 'onvista' | 'yahoo' | 'coingecko' | 'manual';

export interface AssetSearchResult {
  readonly source: Exclude<PriceSource, 'manual'>;
  /** Symbole de cotation dans la source (Onvista « STOCK:92472 », Yahoo « NVDA », CoinGecko « bitcoin »). */
  readonly priceSymbol: string;
  /** Symbole affiché (« NVDA », « BTC »). */
  readonly symbol: string;
  readonly name: string;
  readonly kind: HoldingKind;
  readonly exchange: string | null;
  readonly typeLabel: string;
  readonly isin: string | null;
}

export interface SearchOutcome {
  readonly results: readonly AssetSearchResult[];
  /** Sources momentanément indisponibles (affiché à l'utilisateur). */
  readonly unavailable: readonly string[];
}

export interface PricePoint {
  readonly date: string;
  readonly close: number;
}

export interface PriceHistory {
  /** Devise de cotation, normalisée (les pence « GBp » sont convertis en GBP). */
  readonly currency: string;
  readonly points: readonly PricePoint[];
  readonly provider: string;
  /** Nom officiel quand la source le donne. */
  readonly name?: string | null;
}

export interface MarketClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  /** Pause entre deux tentatives (ms) ; 0 en test. */
  readonly retryDelayMs?: number;
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'] as const;
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/**
 * Actions « tokenisées » (xStocks, Ondo, Robinhood…) : jetons qui imitent une
 * action. Chercher « Nvidia » ne doit pas proposer un jeton crypto à la place
 * de l'action.
 */
const TOKENIZED_STOCK = /stock|tokeni[sz]ed|securities|robinhood token|dinari|backed|reality protocol|\(ondo/i;

const YAHOO_KIND: Readonly<Record<string, HoldingKind>> = {
  EQUITY: 'EQUITY',
  ETF: 'ETF',
  MUTUALFUND: 'FUND',
  CRYPTOCURRENCY: 'CRYPTO',
  BOND: 'BOND',
};

const KIND_LABEL: Readonly<Record<string, string>> = {
  EQUITY: 'Action',
  ETF: 'ETF',
  FUND: 'Fonds',
  CRYPTO: 'Crypto',
  BOND: 'Obligation',
  OTHER: 'Autre',
};

export class MarketClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #retryDelayMs: number;
  readonly #searchCache = new Map<string, { at: number; outcome: SearchOutcome }>();
  readonly #fxCache = new Map<string, { at: number; rates: Map<string, number> }>();

  constructor(options: MarketClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#retryDelayMs = options.retryDelayMs ?? 800;
  }

  /* ------------------------------------------------------------- recherche */

  async search(query: string): Promise<SearchOutcome> {
    const q = query.trim();
    if (q.length < 2) return { results: [], unavailable: [] };
    const cacheKey = q.toLowerCase();
    const cached = this.#searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.outcome;

    const unavailable: string[] = [];
    let onvistaDown = false;
    const [onvista, gecko] = await Promise.all([
      onvistaSearch(this.#fetch, q, BROWSER_UA).catch(() => {
        onvistaDown = true;
        return [] as OnvistaSearchResult[];
      }),
      this.#geckoSearch(q).catch(() => {
        unavailable.push('CoinGecko (cryptos)');
        return [] as AssetSearchResult[];
      }),
    ]);
    const securities: AssetSearchResult[] = onvista.map((item) => ({
      source: 'onvista',
      priceSymbol: item.priceSymbol,
      symbol: item.symbol ?? item.isin ?? item.name,
      name: item.name,
      kind: item.kind,
      exchange: null,
      typeLabel: item.typeLabel,
      isin: item.isin,
    }));
    // Yahoo seulement en secours : Onvista muet, ou rien trouvé.
    let yahoo: AssetSearchResult[] = [];
    if (securities.length === 0) {
      yahoo = await this.#yahooSearch(q).catch(() => {
        // Signalé seulement si aucune source de titres n'a répondu.
        if (onvistaDown) unavailable.push('Onvista et Yahoo Finance (actions, ETF)');
        return [] as AssetSearchResult[];
      });
    }
    // Une crypto trouvée des deux côtés n'apparaît qu'une fois (CoinGecko gardé :
    // identifiant stable, historique en euros).
    const geckoSymbols = new Set(gecko.map((item) => item.symbol.toUpperCase()));
    const others = [
      ...securities,
      ...yahoo.filter((item) => !(item.kind === 'CRYPTO' && geckoSymbols.has(item.symbol.toUpperCase()))),
    ];
    // « bitcoin », « ETH » : la crypto d'abord ; sinon les titres d'abord.
    const lower = q.toLowerCase();
    const cryptoFirst = gecko.some((item) => item.symbol.toLowerCase() === lower || item.name.toLowerCase() === lower);
    const results = cryptoFirst ? [...gecko, ...others] : [...others, ...gecko];
    const outcome: SearchOutcome = { results, unavailable };
    if (unavailable.length === 0) this.#searchCache.set(cacheKey, { at: Date.now(), outcome });
    return outcome;
  }

  async #yahooSearch(q: string): Promise<AssetSearchResult[]> {
    const payload = await this.#yahooJson<{
      quotes?: {
        symbol?: string;
        shortname?: string;
        longname?: string;
        quoteType?: string;
        exchDisp?: string;
        typeDisp?: string;
      }[];
    }>(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0`);
    const isin = ISIN_PATTERN.test(q.toUpperCase()) ? q.toUpperCase() : null;
    const results: AssetSearchResult[] = [];
    for (const quote of payload.quotes ?? []) {
      const kind = YAHOO_KIND[quote.quoteType ?? ''];
      if (!kind || !quote.symbol) continue;
      const isCrypto = kind === 'CRYPTO';
      results.push({
        source: 'yahoo',
        priceSymbol: quote.symbol,
        symbol: isCrypto ? quote.symbol.replace(/-[A-Z]{3}$/, '') : quote.symbol,
        name: quote.longname || quote.shortname || quote.symbol,
        kind,
        exchange: quote.exchDisp ?? null,
        typeLabel: KIND_LABEL[kind] ?? 'Autre',
        isin,
      });
    }
    return results;
  }

  async #geckoSearch(q: string): Promise<AssetSearchResult[]> {
    const response = await this.#get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`);
    const payload = (await response.json()) as {
      coins?: { id?: string; symbol?: string; name?: string; market_cap_rank?: number | null }[];
    };
    return (payload.coins ?? [])
      .filter((coin) => coin.id && coin.symbol && coin.name)
      .filter((coin) => !TOKENIZED_STOCK.test(`${coin.id} ${coin.name}`))
      // Les jetons sans rang de capitalisation sont presque toujours des imitations.
      .filter((coin, index) => index < 2 || (coin.market_cap_rank ?? Number.POSITIVE_INFINITY) < 1500)
      .slice(0, 5)
      .map((coin) => ({
        source: 'coingecko' as const,
        priceSymbol: coin.id as string,
        symbol: (coin.symbol as string).toUpperCase(),
        name: coin.name as string,
        kind: 'CRYPTO' as const,
        exchange: null,
        typeLabel: 'Crypto',
        isin: null,
      }));
  }

  /* ------------------------------------------------------------ historique */

  /**
   * Cours quotidiens depuis `from` (inclus) jusqu'à aujourd'hui, dans la devise
   * de cotation. Plusieurs sources sont tentées dans l'ordre ; `null` si aucune
   * ne répond.
   */
  async history(source: PriceSource, priceSymbol: string, from: string): Promise<PriceHistory | null> {
    if (source === 'manual') return null;
    if (source === 'coingecko') return this.#cryptoHistory(priceSymbol, from);
    if (source === 'onvista') {
      const onvista = await onvistaHistory(this.#fetch, priceSymbol, from, BROWSER_UA).catch(() => null);
      return onvista ? { currency: onvista.currency, points: onvista.points, provider: 'onvista', name: onvista.name } : null;
    }
    const yahoo = await this.#yahooHistory(priceSymbol, from).catch(() => null);
    if (yahoo && yahoo.points.length > 0) return yahoo;
    return this.#stooqHistory(priceSymbol, from).catch(() => null);
  }

  /**
   * Équivalent Onvista d'un titre suivi via Yahoo (par ISIN, sinon par nom) :
   * permet de basculer un actif quand Yahoo ne répond plus.
   */
  async resolveOnvista(reference: { isin: string | null; name: string | null; symbol: string | null; kind: string }): Promise<{ priceSymbol: string; isin: string | null } | null> {
    const found = await onvistaResolve(this.#fetch, reference, BROWSER_UA).catch(() => null);
    return found ? { priceSymbol: found.priceSymbol, isin: found.isin } : null;
  }

  async #cryptoHistory(coinId: string, from: string): Promise<PriceHistory | null> {
    const today = this.#today();
    const days = Math.max(1, daysBetween(from, today) + 1);
    const gecko = await this.#geckoHistory(coinId, Math.min(days, 365)).catch(() => null);
    if (gecko && days <= 365) return gecko;
    // Plus d'un an (ou CoinGecko muet) : Yahoo « SYMBOLE-EUR », puis Kraken.
    const symbol = await this.#geckoSymbol(coinId).catch(() => null);
    const longer =
      (symbol ? await this.#yahooHistory(`${symbol}-EUR`, from).catch(() => null) : null) ??
      (symbol ? await this.#krakenHistory(symbol, from).catch(() => null) : null);
    if (!longer) return gecko;
    if (!gecko) return longer;
    // Fusion : CoinGecko fait foi sur ses 365 jours, l'autre source complète avant.
    const recent = new Map(gecko.points.map((point) => [point.date, point.close]));
    const merged = [
      ...longer.points.filter((point) => !recent.has(point.date)),
      ...gecko.points,
    ].sort((a, b) => (a.date < b.date ? -1 : 1));
    return { currency: 'EUR', points: merged, provider: `${gecko.provider}+${longer.provider}` };
  }

  async #geckoHistory(coinId: string, days: number): Promise<PriceHistory | null> {
    const response = await this.#get(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=eur&days=${days}&interval=daily`,
    );
    const payload = (await response.json()) as { prices?: [number, number][] };
    const byDay = new Map<string, number>();
    for (const [timestamp, price] of payload.prices ?? []) {
      if (typeof price === 'number' && price > 0) byDay.set(isoDay(timestamp), price);
    }
    if (byDay.size === 0) return null;
    return { currency: 'EUR', points: sortedPoints(byDay), provider: 'coingecko' };
  }

  async #geckoSymbol(coinId: string): Promise<string | null> {
    const response = await this.#get(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`,
    );
    const payload = (await response.json()) as { symbol?: string };
    return payload.symbol ? payload.symbol.toUpperCase() : null;
  }

  async #krakenHistory(symbol: string, from: string): Promise<PriceHistory | null> {
    const pair = `${symbol === 'BTC' ? 'XBT' : symbol}EUR`;
    const since = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const response = await this.#get(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440&since=${since}`);
    const payload = (await response.json()) as { error?: string[]; result?: Record<string, unknown> };
    if ((payload.error ?? []).length > 0 || !payload.result) return null;
    const series = Object.entries(payload.result).find(([key]) => key !== 'last')?.[1];
    if (!Array.isArray(series)) return null;
    const byDay = new Map<string, number>();
    for (const row of series as unknown[][]) {
      const close = Number(row[4]);
      if (Number.isFinite(close) && close > 0) byDay.set(isoDay(Number(row[0]) * 1000), close);
    }
    return byDay.size > 0 ? { currency: 'EUR', points: sortedPoints(byDay), provider: 'kraken' } : null;
  }

  async #yahooHistory(symbol: string, from: string): Promise<PriceHistory | null> {
    const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 86_400 * 7;
    const period2 = Math.floor(this.#now().getTime() / 1000) + 86_400;
    const payload = await this.#yahooJson<{
      chart?: {
        result?: {
          meta?: {
            currency?: string;
            regularMarketPrice?: number;
            regularMarketTime?: number;
            longName?: string;
            shortName?: string;
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] };
        }[];
      };
    }>(`/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=split`);
    const result = payload.chart?.result?.[0];
    if (!result) return null;
    const rawCurrency = result.meta?.currency ?? 'USD';
    // Places londoniennes : cotation en pence (« GBp » / « GBX »).
    const pence = rawCurrency === 'GBp' || rawCurrency === 'GBX';
    const factor = pence ? 0.01 : 1;
    const currency = pence ? 'GBP' : rawCurrency.toUpperCase();
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const byDay = new Map<string, number>();
    (result.timestamp ?? []).forEach((timestamp, index) => {
      const close = closes[index];
      if (typeof close === 'number' && close > 0) byDay.set(isoDay(timestamp * 1000), close * factor);
    });
    // Dernier cours en séance : la courbe va jusqu'à « maintenant ».
    const live = result.meta?.regularMarketPrice;
    const liveTime = result.meta?.regularMarketTime;
    if (typeof live === 'number' && live > 0 && typeof liveTime === 'number') {
      byDay.set(isoDay(liveTime * 1000), live * factor);
    }
    if (byDay.size === 0) return null;
    return {
      currency,
      points: sortedPoints(byDay).filter((point) => point.date >= shiftDay(from, -7)),
      provider: 'yahoo',
      name: result.meta?.longName ?? result.meta?.shortName ?? null,
    };
  }

  /** Stooq : CSV quotidien, sans clé. Symboles Yahoo convertis (« NVDA » -> « nvda.us »). */
  async #stooqHistory(symbol: string, from: string): Promise<PriceHistory | null> {
    const stooq = toStooqSymbol(symbol);
    if (!stooq) return null;
    const d1 = from.replaceAll('-', '');
    const response = await this.#get(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooq.symbol)}&d1=${d1}&i=d`);
    const csv = await response.text();
    const byDay = new Map<string, number>();
    for (const line of csv.split('\n').slice(1)) {
      const [date, , , , close] = line.split(',');
      const value = Number(close);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) && value > 0) byDay.set(date, value);
    }
    return byDay.size > 0 ? { currency: stooq.currency, points: sortedPoints(byDay), provider: 'stooq' } : null;
  }

  /* -------------------------------------------------------------- devises */

  /**
   * Taux quotidiens « 1 unité de `currency` = x EUR » depuis `from`.
   * Frankfurter (taux BCE) d'abord, Yahoo en secours. `null` si aucun taux.
   */
  async ratesToEur(currency: string, from: string): Promise<Map<string, number> | null> {
    const code = currency.toUpperCase();
    if (code === 'EUR') return new Map();
    const key = `${code}|${from}`;
    const cached = this.#fxCache.get(key);
    if (cached && Date.now() - cached.at < 60 * 60_000) return cached.rates;

    let rates = await this.#frankfurter(code, from).catch(() => null);
    if (!rates || rates.size === 0) {
      const yahoo = await this.#yahooHistory(`${code}EUR=X`, from).catch(() => null);
      rates = yahoo ? new Map(yahoo.points.map((point) => [point.date, point.close])) : null;
    }
    if (!rates || rates.size === 0) return null;
    this.#fxCache.set(key, { at: Date.now(), rates });
    return rates;
  }

  async #frankfurter(code: string, from: string): Promise<Map<string, number> | null> {
    const response = await this.#get(
      `https://api.frankfurter.dev/v1/${shiftDay(from, -7)}..?from=${encodeURIComponent(code)}&to=EUR`,
    );
    const payload = (await response.json()) as { rates?: Record<string, { EUR?: number }> };
    const rates = new Map<string, number>();
    for (const [date, value] of Object.entries(payload.rates ?? {})) {
      if (typeof value.EUR === 'number' && value.EUR > 0) rates.set(date, value.EUR);
    }
    return rates;
  }

  /* ---------------------------------------------------------------- réseau */

  async #yahooJson<T>(path: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const host of YAHOO_HOSTS) {
        try {
          const response = await this.#fetch(`${host}${path}`, {
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
          });
          if (response.ok) return (await response.json()) as T;
          lastError = new Error(`Yahoo HTTP ${response.status}`);
          if (response.status === 404) throw lastError;
        } catch (error) {
          lastError = error;
          if (error instanceof Error && error.message === 'Yahoo HTTP 404') throw error;
        }
      }
      if (attempt === 0 && this.#retryDelayMs > 0) await sleep(this.#retryDelayMs);
    }
    throw lastError instanceof Error ? lastError : new Error('Yahoo injoignable');
  }

  async #get(url: string): Promise<Response> {
    const response = await this.#fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/csv' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} (${new URL(url).host})`);
    return response;
  }

  #today(): string {
    return this.#now().toISOString().slice(0, 10);
  }
}

/* ------------------------------------------------------------------ outils */

/**
 * Convertit des cours en euros avec des taux quotidiens (dernier taux connu au
 * jour du cours ; le premier taux disponible pour les dates antérieures).
 */
export function convertToEur(points: readonly PricePoint[], rates: Map<string, number> | null): PricePoint[] | null {
  if (rates === null) return null;
  if (rates.size === 0) return [...points];
  const dates = [...rates.keys()].sort();
  const converted: PricePoint[] = [];
  let index = 0;
  let current = rates.get(dates[0] as string) as number;
  for (const point of [...points].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    while (index < dates.length && (dates[index] as string) <= point.date) {
      current = rates.get(dates[index] as string) as number;
      index++;
    }
    converted.push({ date: point.date, close: point.close * current });
  }
  return converted;
}

/** Cours au jour `date`, ou au premier jour de bourse suivant (achats programmés). */
export function priceOnOrAfter(points: readonly PricePoint[], date: string): PricePoint | null {
  for (const point of points) {
    if (point.date >= date) return point;
  }
  return null;
}

/** Dernier cours connu au jour `date` (ou avant). */
export function priceOnOrBefore(points: readonly PricePoint[], date: string): PricePoint | null {
  let found: PricePoint | null = null;
  for (const point of points) {
    if (point.date > date) break;
    found = point;
  }
  return found;
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? 'Autre';
}

function toStooqSymbol(symbol: string): { symbol: string; currency: string } | null {
  const upper = symbol.toUpperCase();
  if (/^[A-Z.]{1,6}$/.test(upper) && !upper.includes('.')) return { symbol: `${upper.toLowerCase()}.us`, currency: 'USD' };
  const suffixes: Readonly<Record<string, { stooq: string; currency: string }>> = {
    DE: { stooq: 'de', currency: 'EUR' },
    L: { stooq: 'uk', currency: 'GBP' },
    T: { stooq: 'jp', currency: 'JPY' },
    HK: { stooq: 'hk', currency: 'HKD' },
  };
  const match = /^([A-Z0-9-]+)\.([A-Z]+)$/.exec(upper);
  if (!match) return null;
  const mapped = suffixes[match[2] as string];
  return mapped ? { symbol: `${(match[1] as string).toLowerCase()}.${mapped.stooq}`, currency: mapped.currency } : null;
}

function sortedPoints(byDay: Map<string, number>): PricePoint[] {
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, close]) => ({ date, close }));
}

function isoDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
