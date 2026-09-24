import type { HoldingKind } from '@suiviinvest/api-contract';

/**
 * Onvista : cours d'actions, d'ETF et de fonds, sans clé.
 *
 * Portail financier allemand dont l'API JSON publique couvre les places
 * européennes et américaines, avec des cotations **en euros** (Tradegate, Xetra,
 * LS Exchange…) : pas de conversion de devise pour la plupart des titres, et
 * des cours proches de ceux des courtiers européens. Recherche par nom, ticker,
 * ISIN ou WKN ; historique quotidien ajusté des divisions.
 *
 * Endpoint non contractuel (comme Yahoo) : isolé ici, avec repli ailleurs.
 *
 * Identifiant de cotation stocké : « TYPE:identifiant » (ex. « STOCK:92472 »,
 * « FUND:26625454 ») ; la place de cotation est choisie à chaque lecture.
 */

const API = 'https://api.onvista.de/api/v1';
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/** Places préférées : euros, historique long, prix proches des courtiers européens. */
const PREFERRED_MARKETS = ['_GAT', '_GER', '_PAR', '_AMS', '_MIL', '_LSX', '_TRO', '_FRA', '_STU'];

export interface OnvistaSearchResult {
  readonly priceSymbol: string;
  readonly symbol: string | null;
  readonly name: string;
  readonly kind: HoldingKind;
  readonly isin: string | null;
  readonly typeLabel: string;
}

export interface OnvistaHistory {
  readonly currency: string;
  readonly points: { date: string; close: number }[];
  readonly market: string;
  readonly name: string | null;
  readonly isin: string | null;
}

interface RawResult {
  entityType?: string;
  entitySubType?: string;
  entityValue?: string;
  name?: string;
  isin?: string;
  symbol?: string;
}

interface RawQuote {
  market?: { name?: string; codeMarket?: string; idNotation?: number };
  isoCurrency?: string;
  last?: number;
  datetimeLast?: string;
}

async function getJson<T>(fetchImpl: typeof fetch, url: string, userAgent: string): Promise<T> {
  const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Onvista HTTP ${response.status}`);
  return (await response.json()) as T;
}

function kindOf(result: RawResult): HoldingKind | null {
  if (result.entityType === 'STOCK') return 'EQUITY';
  if (result.entityType === 'FUND') return result.entitySubType === 'ETF' ? 'ETF' : 'FUND';
  return null;
}

const LABEL: Readonly<Record<string, string>> = { EQUITY: 'Action', ETF: 'ETF', FUND: 'Fonds' };

/** Recherche (actions, ETF, fonds) ; les produits dérivés, indices et obligations sont écartés. */
export async function onvistaSearch(
  fetchImpl: typeof fetch,
  query: string,
  userAgent: string,
  limit = 10,
): Promise<OnvistaSearchResult[]> {
  const payload = await getJson<{ facets?: { type?: string; results?: RawResult[] | null }[] }>(
    fetchImpl,
    `${API}/instruments/search/facet?searchValue=${encodeURIComponent(query)}`,
    userAgent,
  );
  const results: OnvistaSearchResult[] = [];
  const seen = new Set<string>();
  for (const facet of payload.facets ?? []) {
    if (!['STOCK', 'ETF', 'FUND'].includes(facet.type ?? '')) continue;
    for (const raw of (facet.results ?? []).slice(0, 4)) {
      const kind = kindOf(raw);
      if (!kind || !raw.entityValue || !raw.name) continue;
      const priceSymbol = `${raw.entityType}:${raw.entityValue}`;
      if (seen.has(priceSymbol)) continue;
      seen.add(priceSymbol);
      results.push({
        priceSymbol,
        symbol: raw.symbol ?? null,
        name: raw.name,
        kind,
        isin: raw.isin ?? null,
        typeLabel: LABEL[kind] ?? 'Autre',
      });
    }
  }
  return results.slice(0, limit);
}

/**
 * Retrouve un titre déjà connu ailleurs (Yahoo, synchronisation), sans jamais
 * rattacher un cours à un autre titre :
 *  1. par ISIN (exact) ;
 *  2. par ticker (« NVDA », « AI.PA » -> « AI ») si le nom concorde ;
 *  3. par nom, seulement si un résultat unique reprend tous ses mots distinctifs.
 */
export async function onvistaResolve(
  fetchImpl: typeof fetch,
  reference: { isin: string | null; name: string | null; symbol: string | null; kind: string },
  userAgent: string,
): Promise<OnvistaSearchResult | null> {
  const isin = reference.isin?.toUpperCase() ?? null;
  if (isin && ISIN_PATTERN.test(isin)) {
    const found = await onvistaSearch(fetchImpl, isin, userAgent);
    return found.find((item) => item.isin === isin) ?? null;
  }
  if (!reference.name) return null;
  const sameKind = (item: OnvistaSearchResult): boolean =>
    reference.kind === 'EQUITY' ? item.kind === 'EQUITY' : reference.kind === 'ETF' || reference.kind === 'FUND' ? item.kind !== 'EQUITY' : true;
  const wanted = words(reference.name);
  if (wanted.length === 0) return null;

  const ticker = reference.symbol?.toUpperCase().split(/[.:-]/)[0] ?? '';
  if (/^[A-Z0-9]{1,6}$/.test(ticker)) {
    const byTicker = await onvistaSearch(fetchImpl, ticker, userAgent);
    const match = byTicker.find((item) => sameKind(item) && words(item.name)[0] === wanted[0]);
    if (match) return match;
  }
  const byName = (await onvistaSearch(fetchImpl, reference.name, userAgent)).filter((item) => {
    if (!sameKind(item)) return false;
    const have = new Set(words(item.name));
    return wanted.every((word) => have.has(word));
  });
  return byName.length === 1 ? (byName[0] as OnvistaSearchResult) : null;
}

/** Mots distinctifs d'un nom (sans formes juridiques ni mots génériques). */
function words(name: string): string[] {
  const generic = new Set(['inc', 'corp', 'corporation', 'sa', 'se', 'ag', 'plc', 'ltd', 'co', 'company', 'the', 'nv', 'class', 'shares', 'ucits', 'etf', 'acc', 'dist', 'dis']);
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  ).filter((word) => word.length > 1 && !generic.has(word));
}

/** Historique quotidien depuis `from`, plus le dernier cours de la séance en cours. */
export async function onvistaHistory(
  fetchImpl: typeof fetch,
  priceSymbol: string,
  from: string,
  userAgent: string,
): Promise<OnvistaHistory | null> {
  const match = /^(STOCK|FUND):(\d+)$/.exec(priceSymbol);
  if (!match) return null;
  const [, type, id] = match as unknown as [string, string, string];
  const snapshot = await getJson<{
    instrument?: { name?: string; isin?: string };
    quoteList?: { list?: RawQuote[] };
  }>(fetchImpl, `${API}/instruments/${type}/${id}/snapshot`, userAgent);
  const quote = pickQuote(snapshot.quoteList?.list ?? []);
  if (!quote?.market?.idNotation) return null;

  const history = await getJson<{
    isoCurrency?: string;
    datetimeLast?: number[];
    last?: (number | null)[];
  }>(
    fetchImpl,
    `${API}/instruments/${type}/${id}/eod_history?idNotation=${quote.market.idNotation}&range=MAX&startDate=${from}`,
    userAgent,
  );
  const rawCurrency = history.isoCurrency ?? quote.isoCurrency ?? 'EUR';
  const pence = rawCurrency === 'GBp' || rawCurrency === 'GBX';
  const factor = pence ? 0.01 : 1;
  const byDay = new Map<string, number>();
  (history.datetimeLast ?? []).forEach((timestamp, index) => {
    const close = history.last?.[index];
    if (typeof close === 'number' && close > 0) byDay.set(new Date(timestamp * 1000).toISOString().slice(0, 10), close * factor);
  });
  // Cours de la séance en cours : la courbe va jusqu'à « maintenant ».
  if (typeof quote.last === 'number' && quote.last > 0 && quote.datetimeLast) {
    byDay.set(quote.datetimeLast.slice(0, 10), quote.last * factor);
  }
  if (byDay.size === 0) return null;
  return {
    currency: pence ? 'GBP' : rawCurrency.toUpperCase(),
    points: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, close]) => ({ date, close })),
    market: quote.market.name ?? '',
    name: snapshot.instrument?.name ?? null,
    isin: snapshot.instrument?.isin ?? null,
  };
}

/** Dernier cours (séance en cours, place en euros de préférence) et son heure. */
export async function onvistaLive(
  fetchImpl: typeof fetch,
  priceSymbol: string,
  userAgent: string,
): Promise<{ price: number; currency: string; at: string } | null> {
  const match = /^(STOCK|FUND):(\d+)$/.exec(priceSymbol);
  if (!match) return null;
  const snapshot = await getJson<{ quoteList?: { list?: RawQuote[] } }>(
    fetchImpl,
    `${API}/instruments/${match[1]}/${match[2]}/snapshot`,
    userAgent,
  );
  const quote = pickQuote(snapshot.quoteList?.list ?? []);
  if (!quote || typeof quote.last !== 'number' || !(quote.last > 0) || !quote.datetimeLast) return null;
  const raw = quote.isoCurrency ?? 'EUR';
  const pence = raw === 'GBp' || raw === 'GBX';
  return {
    price: quote.last * (pence ? 0.01 : 1),
    currency: pence ? 'GBP' : raw.toUpperCase(),
    at: new Date(quote.datetimeLast).toISOString(),
  };
}

function pickQuote(list: readonly RawQuote[]): RawQuote | null {
  const usable = list.filter((quote) => quote.market?.idNotation);
  for (const code of PREFERRED_MARKETS) {
    const found = usable.find((quote) => quote.market?.codeMarket === code && quote.isoCurrency === 'EUR');
    if (found) return found;
  }
  return usable.find((quote) => quote.isoCurrency === 'EUR') ?? usable[0] ?? null;
}
