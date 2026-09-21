/**
 * Abstraction « data provider » EVM : des fournisseurs interchangeables pour
 * lire une adresse publique (soldes, jetons, transactions, transferts).
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY — aucune écriture, aucune signature
 * ---------------------------------------------------------------------------
 * Toutes les méthodes sont des lectures HTTP. Il n'existe ici ni `sendTransaction`,
 * ni `signMessage`, ni `approve` : le type `EvmDataProvider` ne contient aucune
 * méthode d'écriture, il est donc impossible d'en ajouter une par accident.
 *
 * ---------------------------------------------------------------------------
 * STATUT DE VÉRIFICATION (à ne jamais surinterpréter)
 * ---------------------------------------------------------------------------
 * `verifiedAgainstLiveService = false` PARTOUT : aucun de ces providers n'a été
 * rejoué contre le service réel avec une adresse de test. Ce qui a été vérifié le
 * 2026-09-21 est uniquement la JOIGNABILITÉ de certains points d'entrée sans clé
 * (voir docs/connectors/MISSION2_STATE.md). Les formats de réponse sont supposés
 * conformes aux APIs documentées et doivent être confirmés en conditions réelles.
 *
 * Quatre providers sont fournis, dans un ordre configurable par l'utilisateur :
 *  1. `etherscan`  — Etherscan V2, multi-chaînes, clé OPTIONNELLE ;
 *  2. `blockscout` — sans clé sur toutes les chaînes qui ont une instance ;
 *  3. `alchemy`    — clé optionnelle (nécessaire pour fonctionner) ;
 *  4. `routescan`  — compatible Etherscan, sans clé.
 *
 * Le repli automatique est assuré par `EvmProviderRegistry` : si un provider
 * échoue ou ne supporte pas la chaîne, le suivant prend le relais.
 */

import { ConnectorError, redact, type HttpClient, type Logger } from '../connector.ts';
import type { EvmChain } from './chains.ts';
import { ProviderHttpClient, type ProviderHttpOptions } from './rate-limit.ts';
import { unitsToNumber } from './normalize.ts';

/* --------------------------------------------------------------- contexte */

export interface EvmProviderContext {
  readonly http: HttpClient;
  /** Adresse publique, en minuscules. */
  readonly address: string;
  /** Clé d'API du provider, si l'utilisateur en a fourni une. Jamais journalisée. */
  readonly apiKey: string | null;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface EvmPageOptions {
  /** Numéro de page (1-based), pour les APIs Etherscan-compatibles. */
  readonly page?: number;
  readonly pageSize?: number;
  /** Bloc de départ (reprise incrémentale). */
  readonly startBlock?: number | null;
  /** Curseur opaque du provider (pageKey Alchemy...). */
  readonly cursor?: string | null;
}

/* ------------------------------------------------------------------ types */

export interface EvmNativeBalance {
  readonly chain: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly quantity: number;
}

export interface EvmTokenBalance {
  readonly contractAddress: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly quantity: number;
}

export interface EvmTokenTransfer {
  readonly hash: string;
  readonly logIndex: number;
  readonly blockNumber: number | null;
  /** Horodatage Unix (secondes), ou `null` si absent. */
  readonly timestamp: number | null;
  readonly from: string;
  readonly to: string;
  readonly contractAddress: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Quantité décimale (base units converties). */
  readonly quantity: number;
  readonly rawValue: string;
}

export interface EvmTransaction {
  readonly hash: string;
  readonly blockNumber: number | null;
  readonly timestamp: number | null;
  readonly from: string;
  readonly to: string | null;
  /** Valeur transférée en natif (décimal). */
  readonly value: number;
  readonly gasUsed: number | null;
  /** Frais totaux en natif (`gasUsed * gasPrice`). */
  readonly feeNative: number;
  readonly isError: boolean;
}

export interface EvmPage<T> {
  readonly items: readonly T[];
  /** `true` s'il reste probablement une page. */
  readonly hasMore: boolean;
  /** Curseur à repasser pour obtenir la page suivante, ou `null`. */
  readonly cursor: string | null;
}

/* --------------------------------------------------------------- interface */

export interface EvmDataProvider {
  readonly name: string;
  /**
   * `true` UNIQUEMENT si ce provider a été rejoué contre le service réel.
   * Toujours `false` ici : ne jamais présenter ces providers comme vérifiés.
   */
  readonly verifiedAgainstLiveService: boolean;
  /** Explication lisible de l'état de vérification. */
  readonly verificationNote: string;
  /** La chaîne est-elle couverte par ce provider ? */
  supportsChain(chain: EvmChain): boolean;
  /** Le provider est-il utilisable en l'état (clé présente, endpoint connu) ? */
  isAvailable(ctx: EvmProviderContext): boolean;
  getNativeBalance(ctx: EvmProviderContext, chain: EvmChain): Promise<EvmNativeBalance>;
  getTokenBalances(ctx: EvmProviderContext, chain: EvmChain): Promise<readonly EvmTokenBalance[]>;
  getTransactions(ctx: EvmProviderContext, chain: EvmChain, options?: EvmPageOptions): Promise<EvmPage<EvmTransaction>>;
  getTokenTransfers(ctx: EvmProviderContext, chain: EvmChain, options?: EvmPageOptions): Promise<EvmPage<EvmTokenTransfer>>;
}

/* ------------------------------------------------------- client protégé */

export function providerHttp(ctx: EvmProviderContext, provider: string, overrides: Partial<ProviderHttpOptions> = {}): ProviderHttpClient {
  return new ProviderHttpClient(ctx.http, { provider, ...overrides });
}

/* --------------------------------------------- helpers Etherscan-compatibles */

interface EtherscanEnvelope {
  readonly status?: string;
  readonly message?: string;
  readonly result?: unknown;
}

function joinQuery(base: string, params: URLSearchParams): string {
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}${params.toString()}`;
}

function etherscanArray(payload: unknown, provider: string, what: string, url: string): unknown[] {
  if (payload !== null && typeof payload === 'object') {
    const result = (payload as EtherscanEnvelope).result;
    if (Array.isArray(result)) return result;
    const message = `${(payload as EtherscanEnvelope).message ?? ''} ${
      typeof result === 'string' ? result : ''
    }`.trim();
    if (/no\s+(transactions|records|token|result)/i.test(message) || message === '') return [];
    if (/rate limit|max rate|limit reached/i.test(message)) {
      throw new ConnectorError(provider, 'RATE_LIMITED', `Limite de débit atteinte sur ${redact(url)} : ${redact(message)}`);
    }
    if (/invalid api key|missing|api key/i.test(message)) {
      throw new ConnectorError(provider, 'AUTH_REQUIRED', `Clé d'API refusée par ${provider} : ${redact(message)}`);
    }
    if (/notok/i.test(message)) {
      throw new ConnectorError(provider, 'PROVIDER_BROKEN', `Réponse d'erreur de ${provider} pour ${what} : ${redact(message)}`);
    }
  }
  throw new ConnectorError(provider, 'PROVIDER_BROKEN', `Réponse inexploitable de ${provider} pour ${what} sur ${redact(url)}`);
}

function singleResult(payload: unknown, provider: string, what: string, url: string): string | number {
  if (payload !== null && typeof payload === 'object') {
    const result = (payload as EtherscanEnvelope).result;
    if (typeof result === 'string' || typeof result === 'number') {
      const message = String((payload as EtherscanEnvelope).message ?? '');
      if (/notok/i.test(message) && /rate limit|max rate/i.test(message)) {
        throw new ConnectorError(provider, 'RATE_LIMITED', `Limite de débit atteinte sur ${redact(url)}`);
      }
      if (result !== '') return result;
    }
    const message = `${(payload as EtherscanEnvelope).message ?? ''} ${String(
      (payload as EtherscanEnvelope).result ?? '',
    )}`;
    if (/rate limit|max rate/i.test(message)) {
      throw new ConnectorError(provider, 'RATE_LIMITED', `Limite de débit atteinte sur ${redact(url)}`);
    }
    if (/invalid api key|missing api key/i.test(message)) {
      throw new ConnectorError(provider, 'AUTH_REQUIRED', `Clé d'API refusée par ${provider}.`);
    }
  }
  throw new ConnectorError(provider, 'PROVIDER_BROKEN', `Réponse inexploitable de ${provider} pour ${what}.`);
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBlockNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = value.startsWith('0x') ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* ------------------------------------- provider style Etherscan-compatible */

export interface EtherscanStyleOptions {
  readonly name: string;
  /** Base de l'endpoint API (peut déjà contenir un `?`). */
  readonly baseUrl: (chain: EvmChain) => string;
  /** Nom du paramètre de clé d'API, ou `null` si le service n'en accepte pas. */
  readonly apiKeyParam: string | null;
  readonly supports: (chain: EvmChain) => boolean;
  readonly verificationNote: string;
  /** Ajoute `apikey` avec la valeur fournie ; jamais journalisée. */
}

function createEtherscanStyleProvider(options: EtherscanStyleOptions): EvmDataProvider {
  const provider = options.name;

  async function call(
    ctx: EvmProviderContext,
    chain: EvmChain,
    params: URLSearchParams,
  ): Promise<unknown> {
    if (options.apiKeyParam && ctx.apiKey) params.set(options.apiKeyParam, ctx.apiKey);
    const url = joinQuery(options.baseUrl(chain), params);
    const client = providerHttp(ctx, provider);
    return client.json<unknown>(url, { method: 'GET' });
  }

  return {
    name: provider,
    verifiedAgainstLiveService: false,
    verificationNote: options.verificationNote,
    supportsChain: options.supports,
    isAvailable: () => true,

    async getNativeBalance(ctx, chain): Promise<EvmNativeBalance> {
      const params = new URLSearchParams({
        module: 'account',
        action: 'balance',
        address: ctx.address,
        tag: 'latest',
      });
      const payload = await call(ctx, chain, params);
      const raw = singleResult(payload, provider, 'le solde natif', options.baseUrl(chain));
      const quantity = unitsToNumber(String(raw), chain.nativeDecimals);
      if (quantity === null) {
        throw new ConnectorError(provider, 'DATA', `Solde natif illisible : « ${redact(String(raw))} »`);
      }
      return { chain: chain.id, symbol: chain.nativeSymbol, decimals: chain.nativeDecimals, quantity };
    },

    async getTokenBalances(ctx, chain): Promise<readonly EvmTokenBalance[]> {
      // Aucun endpoint « soldes de jetons » dans le palier gratuit : on agrège
      // les transferts du wallet. Résultat déterministe, jamais inventé.
      const page = await this.getTokenTransfers(ctx, chain, { pageSize: 500 });
      const totals = new Map<string, { contractAddress: string; symbol: string; name: string; decimals: number; quantity: number }>();
      for (const transfer of page.items) {
        const key = transfer.contractAddress.toLowerCase();
        const entry = totals.get(key) ?? {
          contractAddress: key,
          symbol: transfer.symbol,
          name: transfer.name,
          decimals: transfer.decimals,
          quantity: 0,
        };
        const incoming = transfer.to.toLowerCase() === ctx.address;
        entry.quantity = Number((entry.quantity + (incoming ? transfer.quantity : -transfer.quantity)).toFixed(12));
        totals.set(key, entry);
      }
      return [...totals.values()].filter((token) => token.quantity > 0);
    },

    async getTransactions(ctx, chain, pageOptions = {}): Promise<EvmPage<EvmTransaction>> {
      const pageSize = Math.min(Math.max(pageOptions.pageSize ?? 100, 1), 1000);
      const params = new URLSearchParams({
        module: 'account',
        action: 'txlist',
        address: ctx.address,
        startblock: String(pageOptions.startBlock ?? 0),
        endblock: 'latest',
        page: String(pageOptions.page ?? 1),
        offset: String(pageSize),
        sort: 'asc',
      });
      const payload = await call(ctx, chain, params);
      const rows = etherscanArray(payload, provider, 'la liste des transactions', options.baseUrl(chain));
      const items: EvmTransaction[] = [];
      for (const row of rows) {
        const tx = row as Record<string, unknown>;
        const gasUsed = toNumber(tx.gasUsed);
        const gasPrice = toNumber(tx.gasPrice);
        const feeNative =
          gasUsed !== null && gasPrice !== null
            ? unitsToNumber(String(Math.round(gasUsed * gasPrice)), chain.nativeDecimals) ?? 0
            : 0;
        items.push({
          hash: String(tx.hash ?? ''),
          blockNumber: toBlockNumber(tx.blockNumber),
          timestamp: toNumber(tx.timeStamp),
          from: String(tx.from ?? '').toLowerCase(),
          to: tx.to === undefined || tx.to === null || tx.to === '' ? null : String(tx.to).toLowerCase(),
          value: unitsToNumber(String(tx.value ?? '0'), chain.nativeDecimals) ?? 0,
          gasUsed,
          feeNative,
          isError: String(tx.isError ?? '0') === '1',
        });
      }
      const hasMore = items.length >= pageSize;
      return { items, hasMore, cursor: hasMore ? String((pageOptions.page ?? 1) + 1) : null };
    },

    async getTokenTransfers(ctx, chain, pageOptions = {}): Promise<EvmPage<EvmTokenTransfer>> {
      const pageSize = Math.min(Math.max(pageOptions.pageSize ?? 100, 1), 1000);
      const params = new URLSearchParams({
        module: 'account',
        action: 'tokentx',
        address: ctx.address,
        startblock: String(pageOptions.startBlock ?? 0),
        endblock: 'latest',
        page: String(pageOptions.page ?? 1),
        offset: String(pageSize),
        sort: 'asc',
      });
      const payload = await call(ctx, chain, params);
      const rows = etherscanArray(payload, provider, 'la liste des transferts', options.baseUrl(chain));
      const items: EvmTokenTransfer[] = [];
      for (const row of rows) {
        const tx = row as Record<string, unknown>;
        const decimals = toNumber(tx.tokenDecimal) ?? 18;
        const rawValue = String(tx.value ?? '0');
        const quantity = unitsToNumber(rawValue, decimals);
        if (quantity === null) continue;
        items.push({
          hash: String(tx.hash ?? ''),
          logIndex: Number(tx.logIndex ?? 0) || 0,
          blockNumber: toBlockNumber(tx.blockNumber),
          timestamp: toNumber(tx.timeStamp),
          from: String(tx.from ?? '').toLowerCase(),
          to: String(tx.to ?? '').toLowerCase(),
          contractAddress: String(tx.contractAddress ?? '').toLowerCase(),
          symbol: String(tx.tokenSymbol ?? 'TOKEN').toUpperCase(),
          name: String(tx.tokenName ?? tx.tokenSymbol ?? 'Jeton'),
          decimals,
          quantity,
          rawValue,
        });
      }
      const hasMore = items.length >= pageSize;
      return { items, hasMore, cursor: hasMore ? String((pageOptions.page ?? 1) + 1) : null };
    },
  };
}

/* --------------------------------------------------- 1. Etherscan V2 */

const ETHERSCAN_NOTE =
  'Provider JAMAIS testé contre le service réel : l’API Etherscan V2 n’a pas été rejouée ' +
  'avec une adresse de test. Format supposé conforme à la documentation officielle. ' +
  'Multi-chaînes via `chainid` ; clé d’API optionnelle (palier gratuit limité à Ethereum, ' +
  'Arbitrum et Polygon — les autres chaînes exigent un palier payant).';

export const etherscanProvider: EvmDataProvider = createEtherscanStyleProvider({
  name: 'etherscan',
  baseUrl: (chain) => `https://api.etherscan.io/v2/api?chainid=${chain.chainId}`,
  apiKeyParam: 'apikey',
  supports: (chain) => chain.etherscanV2Supported,
  verificationNote: ETHERSCAN_NOTE,
});

/* --------------------------------------------------- 2. Blockscout */

const BLOCKSCOUT_NOTE =
  'Provider JAMAIS testé contre le service réel au-delà de la JOIGNABILITÉ HTTP : les ' +
  'instances `eth/base/arbitrum/polygon/optimism.blockscout.com` répondaient sans clé ' +
  '(audit 2026-09-21), mais le format des réponses n’a pas été rejoué. Sans clé.';

export const blockscoutProvider: EvmDataProvider = createEtherscanStyleProvider({
  name: 'blockscout',
  baseUrl: (chain) => (chain.blockscoutApi ?? '').replace(/\/$/, ''),
  apiKeyParam: null,
  supports: (chain) => chain.blockscoutApi !== null,
  verificationNote: BLOCKSCOUT_NOTE,
});

/* --------------------------------------------------- 3. Routescan */

const ROUTESCAN_NOTE =
  'Provider JAMAIS testé contre le service réel : seule la disponibilité d’un point d’entrée ' +
  'Avalanche avait été constatée (audit 2026-09-21) ; les autres chaînes refusaient sur le ' +
  'chemin documenté. API compatible Etherscan, sans clé.';

export const routescanProvider: EvmDataProvider = createEtherscanStyleProvider({
  name: 'routescan',
  baseUrl: (chain) => `https://api.routescan.io/v2/network/mainnet/evm/${chain.chainId}/etherscan/api`,
  apiKeyParam: 'apikey',
  supports: (chain) => chain.routescanSupported,
  verificationNote: ROUTESCAN_NOTE,
});

/* --------------------------------------------------- 4. Alchemy */

const ALCHEMY_NOTE =
  'Provider JAMAIS testé contre le service réel : l’API Alchemy (JSON-RPC + méthodes ' +
  '`alchemy_getTokenBalances`, `alchemy_getAssetTransfers`) n’a pas été rejouée. ' +
  'Clé d’API optionnelle mais NÉCESSAIRE pour fonctionner : sans clé, le provider est ' +
  'ignoré et le suivant prend le relais.';

async function alchemyRpc<T>(ctx: EvmProviderContext, chain: EvmChain, method: string, params: unknown[]): Promise<T> {
  const url = `https://${chain.alchemyNetwork}.g.alchemy.com/v2/${ctx.apiKey ?? ''}`;
  const client = providerHttp(ctx, 'alchemy');
  const payload = await client.json<{ result?: unknown; error?: { message?: string } }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (payload.error) {
    throw new ConnectorError('alchemy', 'PROVIDER_BROKEN', `Alchemy a refusé ${method} : ${redact(payload.error.message ?? 'erreur inconnue')}`);
  }
  return payload.result as T;
}

interface AlchemyTransfer {
  readonly hash?: string;
  readonly blockNum?: string;
  readonly from?: string;
  readonly to?: string;
  readonly value?: number | null;
  readonly category?: string;
  readonly rawContract?: { readonly address?: string; readonly value?: string; readonly decimal?: string };
  readonly metadata?: { readonly blockTimestamp?: string; readonly symbol?: string; readonly name?: string; readonly decimals?: number };
}

async function alchemyAssetTransfers(
  ctx: EvmProviderContext,
  chain: EvmChain,
  category: string,
  pageOptions: EvmPageOptions,
): Promise<{ transfers: AlchemyTransfer[]; pageKey: string | null }> {
  const maxCount = Math.min(Math.max(pageOptions.pageSize ?? 100, 1), 1000);
  const base = {
    fromBlock: '0x0',
    toBlock: 'latest',
    category: [category],
    withMetadata: true,
    excludeZeroValue: true,
    maxCount: `0x${maxCount.toString(16)}`,
  };
  const merged: AlchemyTransfer[] = [];
  let pageKey: string | null = pageOptions.cursor ?? null;
  let hasMore = false;
  // `fromAddress` et `toAddress` sont exclusifs : deux appels pour voir les deux sens.
  for (const direction of ['from', 'to'] as const) {
    const params: Record<string, unknown> = { ...base };
    params[direction === 'from' ? 'fromAddress' : 'toAddress'] = ctx.address;
    if (pageKey) params.pageKey = pageKey;
    const result = await alchemyRpc<{ transfers?: AlchemyTransfer[]; pageKey?: string }>(
      ctx,
      chain,
      'alchemy_getAssetTransfers',
      [params],
    );
    for (const transfer of result.transfers ?? []) merged.push(transfer);
    if (result.pageKey) {
      pageKey = result.pageKey;
      hasMore = true;
    }
  }
  return { transfers: merged, pageKey: hasMore ? pageKey : null };
}

export const alchemyProvider: EvmDataProvider = {
  name: 'alchemy',
  verifiedAgainstLiveService: false,
  verificationNote: ALCHEMY_NOTE,
  supportsChain: () => true,
  isAvailable: (ctx) => ctx.apiKey !== null && ctx.apiKey !== '',

  async getNativeBalance(ctx, chain): Promise<EvmNativeBalance> {
    const raw = await alchemyRpc<string>(ctx, chain, 'eth_getBalance', [ctx.address, 'latest']);
    const quantity = unitsToNumber(String(raw ?? ''), chain.nativeDecimals);
    if (quantity === null) {
      throw new ConnectorError('alchemy', 'DATA', `Solde natif illisible : « ${redact(String(raw))} »`);
    }
    return { chain: chain.id, symbol: chain.nativeSymbol, decimals: chain.nativeDecimals, quantity };
  },

  async getTokenBalances(ctx, chain): Promise<readonly EvmTokenBalance[]> {
    const result = await alchemyRpc<{
      tokenBalances?: { contractAddress?: string; tokenBalance?: string }[];
    }>(ctx, chain, 'alchemy_getTokenBalances', [ctx.address, 'erc20']);
    const tokens: EvmTokenBalance[] = [];
    for (const entry of result.tokenBalances ?? []) {
      const contract = String(entry.contractAddress ?? '').toLowerCase();
      const raw = String(entry.tokenBalance ?? '');
      if (contract === '' || raw === '' || raw === '0x' || /^0x0+$/.test(raw)) continue;
      let metadata: { symbol?: string; name?: string; decimals?: number } = {};
      try {
        metadata = await alchemyRpc<{ symbol?: string; name?: string; decimals?: number }>(
          ctx,
          chain,
          'alchemy_getTokenMetadata',
          [contract],
        );
      } catch {
        // Métadonnées indisponibles : on garde le contrat, sans inventer de symbole.
      }
      const decimals = typeof metadata.decimals === 'number' ? metadata.decimals : 18;
      const quantity = unitsToNumber(raw.startsWith('0x') ? BigInt(raw).toString() : raw, decimals);
      if (quantity === null || quantity <= 0) continue;
      tokens.push({
        contractAddress: contract,
        symbol: String(metadata.symbol ?? 'TOKEN').toUpperCase(),
        name: String(metadata.name ?? metadata.symbol ?? 'Jeton'),
        decimals,
        quantity,
      });
    }
    return tokens;
  },

  async getTransactions(ctx, chain, pageOptions = {}): Promise<EvmPage<EvmTransaction>> {
    const { transfers, pageKey } = await alchemyAssetTransfers(ctx, chain, 'external', pageOptions);
    const items: EvmTransaction[] = transfers.map((transfer) => ({
      hash: String(transfer.hash ?? ''),
      blockNumber: toBlockNumber(transfer.blockNum ?? null),
      timestamp: transfer.metadata?.blockTimestamp ? Math.floor(Date.parse(transfer.metadata.blockTimestamp) / 1000) : null,
      from: String(transfer.from ?? '').toLowerCase(),
      to: transfer.to === null || transfer.to === undefined ? null : String(transfer.to).toLowerCase(),
      value: Number(transfer.value ?? 0),
      gasUsed: null,
      // Le gaz n'est pas fourni par `getAssetTransfers` : on ne l'invente pas.
      feeNative: 0,
      isError: false,
    }));
    return { items, hasMore: pageKey !== null, cursor: pageKey };
  },

  async getTokenTransfers(ctx, chain, pageOptions = {}): Promise<EvmPage<EvmTokenTransfer>> {
    const { transfers, pageKey } = await alchemyAssetTransfers(ctx, chain, 'erc20', pageOptions);
    const items: EvmTokenTransfer[] = [];
    for (const transfer of transfers) {
      const rawValue = String(transfer.rawContract?.value ?? '0x0');
      const decimals = Number(transfer.rawContract?.decimal ?? transfer.metadata?.decimals ?? 18);
      const normalizedRaw = rawValue.startsWith('0x') ? BigInt(rawValue).toString() : rawValue;
      const quantity = unitsToNumber(normalizedRaw, Number.isFinite(decimals) ? decimals : 18);
      if (quantity === null) continue;
      items.push({
        hash: String(transfer.hash ?? ''),
        logIndex: 0,
        blockNumber: toBlockNumber(transfer.blockNum ?? null),
        timestamp: transfer.metadata?.blockTimestamp
          ? Math.floor(Date.parse(transfer.metadata.blockTimestamp) / 1000)
          : null,
        from: String(transfer.from ?? '').toLowerCase(),
        to: String(transfer.to ?? '').toLowerCase(),
        contractAddress: String(transfer.rawContract?.address ?? '').toLowerCase(),
        symbol: String(transfer.metadata?.symbol ?? transfer.rawContract?.address ?? 'TOKEN').toUpperCase(),
        name: String(transfer.metadata?.name ?? transfer.metadata?.symbol ?? 'Jeton'),
        decimals: Number.isFinite(decimals) ? decimals : 18,
        quantity,
        rawValue: normalizedRaw,
      });
    }
    return { items, hasMore: pageKey !== null, cursor: pageKey };
  },
};

/* --------------------------------------------------------- fabrique */

/** Ordre de préférence par défaut : Etherscan, Blockscout, Routescan, Alchemy. */
export const DEFAULT_PROVIDER_ORDER: readonly string[] = ['etherscan', 'blockscout', 'routescan', 'alchemy'];

export function defaultEvmProviders(): readonly EvmDataProvider[] {
  return [etherscanProvider, blockscoutProvider, routescanProvider, alchemyProvider];
}

export function providerMap(providers: readonly EvmDataProvider[] = defaultEvmProviders()): Map<string, EvmDataProvider> {
  return new Map(providers.map((provider) => [provider.name, provider]));
}

/* ------------------------------------------------------ registre + repli */

export interface EvmFallbackFailure {
  readonly provider: string;
  readonly chain: string;
  readonly kind: string;
  readonly message: string;
}

export interface EvmFallbackResult<T> {
  /** Provider qui a effectivement répondu. */
  readonly provider: string;
  readonly value: T;
}

export interface EvmQueryOptions<T> {
  readonly chain: EvmChain;
  /** Ordre de préférence (surcharge `config.providerOrder`). */
  readonly order?: readonly string[];
  /** Libellé de l'opération, pour les messages d'erreur. */
  readonly operation: string;
  /** Contexte par provider (la clé d'API dépend du provider). */
  readonly context: (provider: EvmDataProvider) => EvmProviderContext;
  readonly run: (provider: EvmDataProvider, context: EvmProviderContext) => Promise<T>;
}

export interface EvmProviderRegistryOptions {
  readonly providers?: readonly EvmDataProvider[];
  readonly order?: readonly string[];
  /** Identifiant utilisé dans les `ConnectorError` (attribution). */
  readonly owner?: string;
}

/**
 * Registre de providers avec ordre de préférence configurable et repli
 * automatique. Un provider qui ne supporte pas la chaîne, ou n'est pas
 * disponible (clé absente), est simplement ignoré ; un provider qui ÉCHOUE
 * cède la place au suivant. Si AUCUN ne répond, une erreur explicite est
 * levée (jamais un résultat vide silencieux).
 */
export class EvmProviderRegistry {
  readonly #providers: Map<string, EvmDataProvider>;
  readonly #order: readonly string[];
  readonly #owner: string;

  constructor(options: EvmProviderRegistryOptions = {}) {
    const providers = options.providers ?? defaultEvmProviders();
    this.#providers = providerMap(providers);
    this.#owner = options.owner ?? 'metamask';
    const order = options.order ?? DEFAULT_PROVIDER_ORDER;
    // On complète l'ordre avec les providers connus mais non listés, pour ne
    // jamais en « perdre » un par une configuration partielle.
    this.#order = [...new Set([...order, ...this.#providers.keys()])];
  }

  get order(): readonly string[] {
    return this.#order;
  }

  get names(): readonly string[] {
    return [...this.#providers.keys()];
  }

  /** Providers dans l'ordre effectif, pour une surcharge éventuelle. */
  ordered(orderOverride?: readonly string[]): readonly EvmDataProvider[] {
    const effective = orderOverride && orderOverride.length > 0 ? orderOverride : this.#order;
    return effective
      .map((name) => this.#providers.get(name))
      .filter((provider): provider is EvmDataProvider => provider !== undefined);
  }

  /** Exécute une opération en essayant les providers dans l'ordre. */
  async query<T>(options: EvmQueryOptions<T>): Promise<EvmFallbackResult<T>> {
    const failures: EvmFallbackFailure[] = [];
    let considered = 0;
    for (const provider of this.ordered(options.order)) {
      if (!provider.supportsChain(options.chain)) continue;
      const context = options.context(provider);
      if (!provider.isAvailable(context)) continue;
      considered += 1;
      try {
        const value = await options.run(provider, context);
        return { provider: provider.name, value };
      } catch (error) {
        const kind = error instanceof ConnectorError ? error.kind : 'DATA';
        const raw = error instanceof Error ? error.message : 'erreur inconnue';
        failures.push({ provider: provider.name, chain: options.chain.id, kind, message: redact(raw) });
      }
    }

    if (considered === 0) {
      throw new ConnectorError(
        this.#owner,
        'NOT_SUPPORTED',
        `Aucun fournisseur disponible pour ${options.chain.name} (${options.operation}) : ` +
          'configurez une clé d’API ou activez un autre provider.',
      );
    }
    throw new ConnectorError(
      this.#owner,
      'PROVIDER_DOWN',
      `Tous les fournisseurs ont échoué pour ${options.chain.name} (${options.operation}) : ` +
        failures.map((failure) => `${failure.provider} (${failure.kind})`).join(', '),
    );
  }
}
