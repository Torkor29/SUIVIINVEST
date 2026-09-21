import type { FxRate, Quote } from '@suiviinvest/core';
import { round } from '@suiviinvest/core';
import type { MarketDataRefreshResponse } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { InstrumentRepository } from '../repositories/accounts.ts';
import { MarketRepository } from '../repositories/market.ts';

/**
 * Module market data.
 *
 * Principes :
 *  - **plusieurs fournisseurs avec repli** : le modèle métier n'est lié à aucun
 *    fournisseur. Si Yahoo échoue ou change, CoinGecko ou un futur adaptateur
 *    prend le relais — la table `quotes` stocke d'où vient chaque prix ;
 *  - **cache** : un prix déjà en base n'est pas redemandé le même jour ;
 *  - **jamais de valeur inventée** : en cas d'échec, on ne renvoie aucune ligne
 *    et on le signale ; un prix manquant est préférable à un prix faux ;
 *  - **ISIN prioritaire** pour identifier l'instrument.
 *
 * ⚠️ Aucun des fournisseurs ci-dessous n'est une API contractuelle : ce sont des
 * endpoints publics non documentés pour certains (Yahoo). Ils sont isolés ici et
 * peuvent être remplacés sans toucher au reste de l'application.
 */

export interface PriceProvider {
  readonly name: string;
  /** Cours quotidiens d'un instrument. */
  fetchQuotes(instrument: InstrumentRef): Promise<Quote[] | null>;
  /** Taux de change quotidiens vers EUR. */
  fetchFxRates?(currencies: readonly string[], base: string): Promise<FxRate[] | null>;
}

export interface InstrumentRef {
  readonly id: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly currency: string;
  readonly kind: string;
  readonly exchange: string | null;
  readonly chain: string | null;
  readonly contractAddress: string | null;
}

/** Providers disponibles, dans l'ordre de préférence (le premier qui répond gagne). */
export class MarketDataService {
  readonly #db: Db;
  readonly #instruments: InstrumentRepository;
  readonly #market: MarketRepository;
  readonly #providers: readonly PriceProvider[];
  readonly #now: () => Date;

  constructor(options: {
    db: Db;
    providers?: readonly PriceProvider[];
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#instruments = new InstrumentRepository(options.db);
    this.#market = new MarketRepository(options.db);
    this.#providers = options.providers ?? defaultProviders();
    this.#now = options.now ?? (() => new Date());
  }

  get providers(): readonly string[] {
    return this.#providers.map((provider) => provider.name);
  }

  /**
   * Rafraîchit les prix des instruments qui en ont besoin.
   * Un instrument peut être traité par plusieurs fournisseurs : le premier
   * résultat non vide est conservé (fallback automatique).
   */
  async refresh(options: { force?: boolean } = {}): Promise<MarketDataRefreshResponse> {
    const instruments = this.#instruments.list().filter((instrument) => instrument.kind !== 'CASH');
    const today = this.#now().toISOString().slice(0, 10);
    const stats = new Map<string, { instruments: number; errors: number }>();
    let refreshed = 0;
    let failed = 0;

    for (const instrument of instruments) {
      if (!options.force) {
        const existing = this.#market.latestQuote(instrument.id, today);
        if (existing && existing.date === today) continue;
      }
      const ref: InstrumentRef = {
        id: instrument.id,
        symbol: instrument.symbol,
        isin: instrument.isin,
        currency: instrument.currency,
        kind: instrument.kind,
        exchange: instrument.exchange,
        chain: instrument.chain,
        contractAddress: instrument.contract_address,
      };

      let done = false;
      for (const provider of this.#providers) {
        const stat = stats.get(provider.name) ?? { instruments: 0, errors: 0 };
        try {
          const quotes = await provider.fetchQuotes(ref);
          if (quotes && quotes.length > 0) {
            this.#market.upsertQuotes(quotes);
            stat.instruments++;
            refreshed++;
            stats.set(provider.name, stat);
            done = true;
            break;
          }
        } catch {
          stat.errors++;
          stats.set(provider.name, stat);
        }
      }
      if (!done) failed++;
    }

    // Taux de change : toutes les devises détenues vers la devise de base.
    const currencies = this.#db.all<{ currency: string }>(
      'SELECT DISTINCT currency FROM accounts UNION SELECT DISTINCT currency FROM activities',
    );
    const needed = currencies
      .map((row) => row.currency)
      .filter((currency) => currency !== 'EUR');
    let fxUpdated = 0;
    for (const provider of this.#providers) {
      if (!provider.fetchFxRates || needed.length === 0) continue;
      try {
        const rates = await provider.fetchFxRates(needed, 'EUR');
        if (rates && rates.length > 0) {
          fxUpdated += this.#market.upsertFxRates(rates);
          break;
        }
      } catch {
        // Un fournisseur de change en échec ne bloque pas les prix.
      }
    }

    return {
      refreshed,
      failed,
      providers: [...stats.entries()].map(([provider, stat]) => ({
        provider,
        instruments: stat.instruments,
        errors: stat.errors,
      })),
      message:
        `${refreshed} instrument(s) mis à jour, ${failed} sans prix disponible, ` +
        `${fxUpdated} taux de change enregistré(s).`,
    };
  }

  /** Prix unitaire connu d'un instrument, à une date donnée (ou le plus récent). */
  priceOf(instrumentId: string, date?: string): number | null {
    return this.#market.latestQuote(instrumentId, date)?.close ?? null;
  }
}

/**
 * Yahoo Finance : endpoint public, non contractuel, sans clé.
 * Utilisé en priorité pour les actions/ETF (couverture mondiale, y compris les
 * places européennes via le suffixe d'exchange).
 */
export class YahooProvider implements PriceProvider {
  readonly name = 'yahoo';
  readonly #fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetchImpl = fetchImpl;
  }

  async fetchQuotes(instrument: InstrumentRef): Promise<Quote[] | null> {
    const symbol = this.#symbolFor(instrument);
    if (!symbol) return null;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
    const response = await this.#fetchImpl(url, {
      headers: { 'User-Agent': 'SuiviInvest/0.1 (personal finance, read-only)' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      chart?: {
        result?: {
          meta?: { currency?: string };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const result = payload.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    const currency = result?.meta?.currency ?? instrument.currency;
    const fetchedAt = new Date().toISOString();
    const quotes: Quote[] = [];
    timestamps.forEach((timestamp, index) => {
      const close = closes[index];
      if (close === null || close === undefined) return;
      quotes.push({
        instrumentId: instrument.id,
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: round(close, 8),
        currency,
        provider: this.name,
        fetchedAt,
      });
    });
    return quotes.length > 0 ? quotes : null;
  }

  /**
   * Symbole Yahoo. Un instrument identifié uniquement par son ISIN n'a pas de
   * symbole exploitable de façon fiable : on renvoie null plutôt que de deviner
   * (un mauvais symbole produirait un prix faux, pire que pas de prix).
   */
  #symbolFor(instrument: InstrumentRef): string | null {
    if (instrument.symbol) return instrument.symbol;
    return null;
  }
}

/**
 * CoinGecko : prix crypto sans clé (quota public limité).
 * Le couple (chaîne, adresse de contrat) est résolu vers un identifiant
 * CoinGecko via la recherche publique.
 */
export class CoinGeckoProvider implements PriceProvider {
  readonly name = 'coingecko';
  readonly #fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetchImpl = fetchImpl;
  }

  async fetchQuotes(instrument: InstrumentRef): Promise<Quote[] | null> {
    if (instrument.kind !== 'CRYPTO') return null;
    const coinId = await this.#resolveCoinId(instrument);
    if (!coinId) return null;
    const url =
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}/market_chart` +
      '?vs_currency=eur&days=365&interval=daily';
    const response = await this.#fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const payload = (await response.json()) as { prices?: [number, number][] };
    const prices = payload.prices ?? [];
    if (prices.length === 0) return null;
    const fetchedAt = new Date().toISOString();
    return prices.map(([timestamp, price]) => ({
      instrumentId: instrument.id,
      date: new Date(timestamp).toISOString().slice(0, 10),
      close: round(price, 8),
      currency: 'EUR',
      provider: this.name,
      fetchedAt,
    }));
  }

  async fetchFxRates(): Promise<FxRate[] | null> {
    const response = await this.#fetchImpl(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=eur',
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) return null;
    return null; // les taux fiat ne sont pas le rôle de ce fournisseur
  }

  async #resolveCoinId(instrument: InstrumentRef): Promise<string | null> {
    if (!instrument.contractAddress) return null;
    const url =
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(instrument.chain ?? 'ethereum')}` +
      `/contract/${encodeURIComponent(instrument.contractAddress)}`;
    const response = await this.#fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const payload = (await response.json()) as { id?: string };
    return payload.id ?? null;
  }
}

/**
 * Banque centrale européenne : taux de référence quotidiens (XML public,
 * gratuit, sans clé). Source fiable pour les devises fiat.
 */
export class EcbFxProvider implements PriceProvider {
  readonly name = 'ecb';
  readonly #fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.#fetchImpl = fetchImpl;
  }

  async fetchQuotes(): Promise<Quote[] | null> {
    return null; // la BCE ne fournit pas de cours d'instruments
  }

  async fetchFxRates(currencies: readonly string[], base: string): Promise<FxRate[] | null> {
    const url = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
    const response = await this.#fetchImpl(url);
    if (!response.ok) return null;
    const xml = await response.text();
    const wanted = new Set(currencies);
    const rates: FxRate[] = [];
    // Analyse volontairement simple : le format est stable et régulier.
    const dayRegex = /<Cube time="(\d{4}-\d{2}-\d{2})">([\s\S]*?)<\/Cube>/g;
    for (const dayMatch of xml.matchAll(dayRegex)) {
      const date = dayMatch[1] as string;
      const body = dayMatch[2] as string;
      for (const rateMatch of body.matchAll(/currency="([A-Z]{3})" rate="([\d.]+)"/g)) {
        const currency = rateMatch[1] as string;
        const rate = Number.parseFloat(rateMatch[2] as string);
        if (!Number.isFinite(rate)) continue;
        if (base === 'EUR' && wanted.has(currency)) {
          rates.push({ base: currency, quote: 'EUR', date, rate: round(1 / rate, 12), source: this.name });
        }
        if (currency === base && base !== 'EUR') {
          rates.push({ base: 'EUR', quote: base, date, rate, source: this.name });
        }
      }
    }
    return rates.length > 0 ? rates : null;
  }
}

export function defaultProviders(): PriceProvider[] {
  return [new YahooProvider(), new CoinGeckoProvider(), new EcbFxProvider()];
}

/** Fournisseur de test : déterministe, aucune sortie réseau. */
export class StaticPriceProvider implements PriceProvider {
  readonly name: string;
  readonly #quotes: Map<string, Quote[]>;
  readonly #fx: FxRate[];

  constructor(options: {
    name?: string;
    quotes?: Record<string, { date: string; close: number; currency?: string }[]>;
    fx?: FxRate[];
  }) {
    this.name = options.name ?? 'static';
    this.#quotes = new Map(
      Object.entries(options.quotes ?? {}).map(([instrumentId, entries]) => [
        instrumentId,
        entries.map((entry) => ({
          instrumentId,
          date: entry.date,
          close: entry.close,
          currency: entry.currency ?? 'EUR',
          provider: this.name,
          fetchedAt: new Date().toISOString(),
        })),
      ]),
    );
    this.#fx = options.fx ?? [];
  }

  async fetchQuotes(instrument: InstrumentRef): Promise<Quote[] | null> {
    return this.#quotes.get(instrument.id) ?? null;
  }

  async fetchFxRates(): Promise<FxRate[] | null> {
    return this.#fx.length > 0 ? this.#fx : null;
  }
}