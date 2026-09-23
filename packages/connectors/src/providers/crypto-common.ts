import { createHash } from 'node:crypto';
import {
  ConnectorError,
  redact,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorContext,
  type ConnectionTestResult,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedPosition,
  type SyncStatusReport,
} from '../connector.ts';
import type { ProviderId } from '@suiviinvest/core';

/**
 * Briques communes aux sources crypto « lecture de soldes » : wallets par
 * adresse publique (Bitcoin, Solana) et plateformes par clé API en lecture
 * seule (Binance, Kraken, Coinbase, Bitpanda).
 *
 * Prix : un seul appel public, sans clé, aux taux Coinbase (plusieurs centaines
 * d'actifs cotés en EUR), CoinGecko en secours pour les actifs absents. Un prix
 * introuvable reste `null` : la quantité est conservée, jamais un zéro inventé.
 */

export const FIAT_CODES: ReadonlySet<string> = new Set([
  'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'JPY', 'AUD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'RON',
]);

/** Identifiants CoinGecko des actifs les plus courants (secours si Coinbase ne cote pas). */
const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  POL: 'polygon-ecosystem-token',
  LINK: 'chainlink',
  LTC: 'litecoin',
  TRX: 'tron',
  ATOM: 'cosmos',
  XLM: 'stellar',
  XMR: 'monero',
  TON: 'the-open-network',
  USDT: 'tether',
  USDC: 'usd-coin',
  DAI: 'dai',
  EURC: 'euro-coin',
  SHIB: 'shiba-inu',
  UNI: 'uniswap',
  NEAR: 'near',
  APT: 'aptos',
  SUI: 'sui',
  ARB: 'arbitrum',
  OP: 'optimism',
  FDUSD: 'first-digital-usd',
  PEPE: 'pepe',
  BONK: 'bonk',
  JUP: 'jupiter-exchange-solana',
  WIF: 'dogwifcoin',
  PYTH: 'pyth-network',
  KAS: 'kaspa',
  ETC: 'ethereum-classic',
  BCH: 'bitcoin-cash',
  ALGO: 'algorand',
  XTZ: 'tezos',
  FIL: 'filecoin',
  INJ: 'injective-protocol',
  RNDR: 'render-token',
  RENDER: 'render-token',
  AAVE: 'aave',
  MKR: 'maker',
};

/** Synonymes : même actif, code différent selon la plateforme. */
const SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  XBT: 'BTC',
  XDG: 'DOGE',
  WETH: 'ETH',
  WBTC: 'BTC',
  BETH: 'ETH',
  STETH: 'ETH',
};

export function canonicalSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return SYMBOL_ALIASES[upper] ?? upper;
}

/**
 * Prix en euros d'une liste de symboles. Une seule requête Coinbase (taux publics),
 * puis CoinGecko pour les manquants connus. Ne lève jamais : un échec de cotation
 * n'empêche pas de remonter les quantités.
 */
export async function pricesEur(ctx: ConnectorContext, symbols: readonly string[]): Promise<Map<string, number>> {
  const wanted = [...new Set(symbols.map(canonicalSymbol))];
  const prices = new Map<string, number>();
  if (wanted.length === 0) return prices;
  prices.set('EUR', 1);

  try {
    const response = await ctx.http.json<{ data?: { rates?: Record<string, string> } }>(
      'https://api.coinbase.com/v2/exchange-rates?currency=EUR',
    );
    const rates = response.data?.rates ?? {};
    for (const symbol of wanted) {
      const rate = Number(rates[symbol]);
      // 1 EUR = `rate` unités : le prix d'une unité vaut 1 / rate.
      if (Number.isFinite(rate) && rate > 0) prices.set(symbol, 1 / rate);
    }
  } catch (error) {
    ctx.logger.warn(`Cotations Coinbase indisponibles : ${redact(error instanceof Error ? error.message : String(error))}`);
  }

  const missing = wanted.filter((symbol) => !prices.has(symbol) && COINGECKO_IDS[symbol] !== undefined);
  if (missing.length > 0) {
    try {
      const ids = missing.map((symbol) => COINGECKO_IDS[symbol] as string);
      const response = await ctx.http.json<Record<string, { eur?: number }>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=eur`,
      );
      for (const symbol of missing) {
        const price = response[COINGECKO_IDS[symbol] as string]?.eur;
        if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices.set(symbol, price);
      }
    } catch (error) {
      ctx.logger.warn(`Cotations CoinGecko indisponibles : ${redact(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return prices;
}

/** Quantité d'un actif détenue sur une source (déjà agrégée). */
export interface Holding {
  readonly symbol: string;
  readonly quantity: number;
  readonly name?: string;
  /** Réseau pour un jeton on-chain (« bitcoin », « solana ») ; `null` pour une plateforme. */
  readonly chain?: string | null;
  readonly contractAddress?: string | null;
  readonly decimals?: number | null;
  /** Prix en EUR déjà connu (source) ; sinon recherché via `pricesEur`. */
  readonly priceEur?: number | null;
}

/** Additionne les quantités d'un même symbole (spot + épargne + financement…). */
export function mergeHoldings(holdings: readonly Holding[]): Holding[] {
  const bySymbol = new Map<string, Holding>();
  for (const holding of holdings) {
    if (!Number.isFinite(holding.quantity) || holding.quantity <= 0) continue;
    const key = `${holding.chain ?? ''}|${holding.contractAddress ?? canonicalSymbol(holding.symbol)}`;
    const existing = bySymbol.get(key);
    bySymbol.set(key, existing ? { ...existing, quantity: existing.quantity + holding.quantity } : holding);
  }
  return [...bySymbol.values()];
}

/**
 * Convertit des avoirs en positions (EUR) et en solde de trésorerie EUR.
 * Les devises autres que l'euro deviennent des positions « CASH » valorisées au
 * taux du jour : elles ne se mélangent jamais au solde en euros.
 */
export async function holdingsToPositions(
  ctx: ConnectorContext,
  accountId: string,
  holdings: readonly Holding[],
  rawSourceType: string,
): Promise<{ positions: NormalizedPosition[]; eurCash: number | null }> {
  const merged = mergeHoldings(holdings);
  const needPrices = merged.filter((holding) => holding.priceEur === undefined || holding.priceEur === null);
  const prices = await pricesEur(ctx, needPrices.map((holding) => holding.symbol));
  const positions: NormalizedPosition[] = [];
  let eurCash: number | null = null;

  for (const holding of merged) {
    const symbol = canonicalSymbol(holding.symbol);
    if (symbol === 'EUR') {
      eurCash = (eurCash ?? 0) + holding.quantity;
      continue;
    }
    const fiat = FIAT_CODES.has(symbol);
    const price = holding.priceEur ?? prices.get(symbol) ?? null;
    positions.push({
      externalAccountId: accountId,
      externalAssetId: holding.contractAddress ?? symbol,
      isin: null,
      symbol,
      name: holding.name ?? symbol,
      kind: fiat ? 'CASH' : 'CRYPTO',
      quantity: holding.quantity,
      unitPrice: price,
      currency: 'EUR',
      chain: holding.chain ?? null,
      contractAddress: holding.contractAddress ?? null,
      decimals: holding.decimals ?? null,
      rawSourceType,
    });
  }
  if (positions.some((position) => position.unitPrice === null)) {
    const unknown = positions.filter((position) => position.unitPrice === null).map((position) => position.symbol);
    ctx.logger.warn(`Aucun cours trouvé pour : ${unknown.join(', ')} (quantités conservées, valeur inconnue).`);
  }
  return { positions, eurCash };
}

/** Identifiant stable et non révélateur d'une configuration (liste d'adresses…). */
export function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

export function requireSecret(providerId: string, value: string | null, label: string): string {
  if (value === null || value.trim() === '') {
    throw new ConnectorError(providerId, 'AUTH_REQUIRED', `${label} manquant : renseignez-le dans Connexions.`);
  }
  return value.trim();
}

/* ------------------------------------------------ fabrique de connecteurs */

export interface BalanceSourceDefinition {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly requiredConfig: readonly string[];
  readonly requiredSecrets: readonly string[];
  /** Compte unique de la connexion (wallet ou compte de plateforme). */
  account(ctx: ConnectorContext): Promise<NormalizedAccount>;
  /** Avoirs actuels ; lève `ConnectorError` si l'accès est refusé. */
  holdings(ctx: ConnectorContext): Promise<readonly Holding[]>;
  readonly rawSourceType: string;
}

/**
 * Connecteur « soldes seulement » : comptes, trésorerie EUR et positions. Pas
 * d'historique de transactions (la valeur du jour fait foi, rien n'est reconstruit).
 */
export function createBalanceConnector(definition: BalanceSourceDefinition): Connector {
  const capabilities: ConnectorCapabilities = {
    accounts: true,
    balances: true,
    positions: true,
    transactions: false,
    income: false,
    api: true,
    completePositions: true,
  };

  // Un même passage de synchro appelle balances puis positions : on ne
  // redemande pas les avoirs deux fois à la source.
  const cache = new Map<string, Promise<{ positions: NormalizedPosition[]; eurCash: number | null }>>();
  const snapshot = (ctx: ConnectorContext, accountId: string) => {
    const key = `${ctx.connectionId}|${ctx.syncRunId}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = definition
        .holdings(ctx)
        .then((holdings) => holdingsToPositions(ctx, accountId, holdings, definition.rawSourceType));
      cache.set(key, pending);
      // Nettoyage : une entrée par passage, supprimée peu après.
      setTimeout(() => cache.delete(key), 60_000).unref?.();
    }
    return pending;
  };

  return {
    id: definition.id,
    displayName: definition.displayName,
    capabilities,
    importFormats: [],
    requiredConfig: definition.requiredConfig,
    requiredSecrets: definition.requiredSecrets,

    async testConnection(ctx): Promise<ConnectionTestResult> {
      try {
        const holdings = await definition.holdings(ctx);
        const count = mergeHoldings(holdings).length;
        return {
          ok: true,
          status: 'CONNECTED',
          message: `${definition.displayName} répond : ${count} actif(s) détenu(s), lecture seule.`,
          requiresUserAction: false,
        };
      } catch (error) {
        if (error instanceof ConnectorError) {
          return { ok: false, status: error.status, message: error.message, requiresUserAction: error.requiresUserAction };
        }
        throw error;
      }
    },

    async syncAccounts(ctx) {
      return [await definition.account(ctx)];
    },

    async syncBalances(ctx, accounts): Promise<readonly NormalizedBalance[]> {
      const account = accounts[0] ?? (await definition.account(ctx));
      // Toujours un solde, même nul : des euros retirés ne doivent pas rester comptés.
      const eurCash = (await snapshot(ctx, account.externalAccountId)).eurCash ?? 0;
      return [
        {
          externalAccountId: account.externalAccountId,
          date: ctx.now().toISOString().slice(0, 10),
          cash: Math.round(eurCash * 100) / 100,
          currency: 'EUR',
          rawSourceType: definition.rawSourceType,
        },
      ];
    },

    async syncPositions(ctx, accounts) {
      const account = accounts[0] ?? (await definition.account(ctx));
      return (await snapshot(ctx, account.externalAccountId)).positions;
    },

    async syncTransactions() {
      return { items: [], cursor: { value: null } };
    },

    async syncIncome() {
      return [];
    },

    async getSyncStatus(): Promise<SyncStatusReport> {
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message: `${definition.displayName} : lecture des soldes, aucune opération possible.`,
        requiresUserAction: false,
      };
    },
  };
}
