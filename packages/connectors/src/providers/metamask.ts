/**
 * Connecteur MetaMask / wallet EVM — STRICTEMENT READ-ONLY.
 *
 * ---------------------------------------------------------------------------
 * GARANTIES DE SÉCURITÉ (non négociables, testées)
 *
 *  - Le connecteur ne connaît QUE l'ADRESSE PUBLIQUE du wallet. Il n'existe
 *    aucune configuration, aucun secret et aucun champ de base de données pour
 *    une clé privée, une phrase de récupération (seed) ou un mot de passe :
 *    toute configuration portant l'un de ces noms est REFUSÉE explicitement
 *    (voir `assertNoSigningMaterial`).
 *  - Aucune signature, aucun envoi de transaction, aucune autorisation de token
 *    (`approve`) n'est implémenté : ce fichier ne fait que LIRE des soldes et
 *    des historiques via des providers d'exploration injectés.
 *  - `capabilities.income = false` : les revenus on-chain ne sont pas devinés.
 *
 * ---------------------------------------------------------------------------
 * CHEMIN API
 *
 *  - Multi-chaînes : `config.chains` (identifiants séparés par des virgules ;
 *    défaut = les 7 réseaux du registre). La clé historique `config.chain` reste
 *    acceptée pour un usage mono-chaîne.
 *  - Providers interchangeables via `config.providerOrder` (défaut :
 *    `etherscan, blockscout, routescan, alchemy`) avec repli automatique — voir
 *    `evm/providers.ts`. Les clés d'API sont OPTIONNELLES et lues via
 *    `ctx.secrets.get('etherscan_api_key' | 'alchemy_api_key' | ...)` ; le
 *    serveur ajoute `SUIVIINVEST_KEY_*` en repli. Jamais journalisées.
 *  - Progression incrémentale via `window.since` + curseur par chaîne ; une
 *    chaîne en échec n'empêche pas les autres d'être remontées (reprise).
 *
 * ---------------------------------------------------------------------------
 * VÉRIFICATION : AUCUN provider n'a été testé contre le service réel
 * (`verifiedAgainstLiveService = false` partout). Seule la joignabilité HTTP de
 * certains points d'entrée a été constatée le 2026-09-21.
 */

import {
  ConnectorError,
  redact,
  type Connector,
  type ConnectorContext,
  type ConnectionTestResult,
  type ImportFormat,
  type ImportParseOptions,
  type ImportParseResult,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedIncome,
  type NormalizedPosition,
  type NormalizedTransaction,
  type SyncCursor,
  type SyncStatusReport,
  type SyncWindow,
} from '../connector.ts';
import type { ActivityType } from '@suiviinvest/core';
import { createAccumulator, pushActivity, pushPosition, rejectRow, toResult, warnOnce } from './shared.ts';
import {
  DEFAULT_CHAIN_IDS,
  EVM_CHAINS,
  EvmProviderRegistry,
  normalizeChainActivity,
  positionsFromBalances,
  unitsToNumber,
  type EvmChain,
  type EvmDataProvider,
  type EvmPage,
  type EvmProviderContext,
  type EvmTokenBalance,
  type EvmTokenTransfer,
  type EvmTransaction,
} from '../evm/index.ts';

const PROVIDER_ID = 'metamask' as const;
const RAW_SOURCE_API = 'evm.onchain';
const RAW_SOURCE_JSON = 'evm.address_json';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Taille de page par défaut des appels d'exploration. */
const DEFAULT_PAGE_SIZE = 100;
/** Garde-fou : nombre maximal de pages parcourues par opération et par chaîne. */
const MAX_PAGES = 20;

/**
 * Registre par défaut, réutilisé pour toutes les connexions. Les providers sont
 * sans état : l'adresse et la clé d'API arrivent dans le contexte d'appel.
 */
const DEFAULT_REGISTRY = new EvmProviderRegistry({ owner: PROVIDER_ID });

/** Champs de configuration qui trahiraient du matériel de signature. */
const FORBIDDEN_CONFIG_KEYS = [
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'seedphrase',
  'seed_phrase',
  'password',
  'passphrase',
  'pin',
];

/**
 * Refuse toute configuration contenant une clé privée / seed / mot de passe.
 * C'est une garde active : le connecteur signale l'erreur au lieu de l'ignorer.
 */
export function assertNoSigningMaterial(config: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(config)) {
    const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
    if (FORBIDDEN_CONFIG_KEYS.includes(normalized)) {
      throw new ConnectorError(
        PROVIDER_ID,
        'DATA',
        `Configuration refusée : le champ « ${key} » ressemble à un secret de signature. ` +
          "Ce connecteur est en LECTURE SEULE et n'accepte qu'une adresse publique.",
      );
    }
  }
}

function requireAddress(ctx: ConnectorContext): string {
  assertNoSigningMaterial(ctx.config);
  const address = (ctx.config.address ?? '').trim();
  if (!ADDRESS_PATTERN.test(address)) {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      'Adresse publique EVM absente ou invalide : renseignez « address » (0x + 40 caractères hexadécimaux).',
    );
  }
  return address.toLowerCase();
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
}

/** Chaînes configurées (défaut : les 7 du registre). */
function configuredChains(ctx: ConnectorContext): EvmChain[] {
  const explicit = splitList(ctx.config.chains);
  const legacy = splitList(ctx.config.chain);
  const ids = explicit.length > 0 ? explicit : legacy.length > 0 ? legacy : [...DEFAULT_CHAIN_IDS];
  const chains: EvmChain[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const chain = EVM_CHAINS[id];
    if (!chain) {
      unknown.push(id);
      continue;
    }
    if (!chains.some((existing) => existing.id === chain.id)) chains.push(chain);
  }
  if (unknown.length > 0) {
    ctx.logger.warn(`Chaînes EVM inconnues ignorées : ${unknown.join(', ')}`);
  }
  return chains;
}

function providerOrder(ctx: ConnectorContext): string[] | undefined {
  const order = splitList(ctx.config.providerOrder);
  return order.length > 0 ? order : undefined;
}

/** Noms de secrets acceptés par provider, dans l'ordre de résolution. */
const PROVIDER_SECRETS: Readonly<Record<string, readonly string[]>> = {
  etherscan: ['etherscan_api_key', 'explorerApiKey'],
  blockscout: [],
  routescan: ['routescan_api_key'],
  alchemy: ['alchemy_api_key'],
};

async function apiKeyFor(ctx: ConnectorContext, provider: string): Promise<string | null> {
  for (const name of PROVIDER_SECRETS[provider] ?? []) {
    const value = await ctx.secrets.get(name);
    if (value && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Contexte d'appel par provider : la clé d'API dépend du provider visé. */
async function buildContexts(ctx: ConnectorContext, address: string): Promise<Map<string, EvmProviderContext>> {
  const contexts = new Map<string, EvmProviderContext>();
  for (const name of DEFAULT_REGISTRY.names) {
    contexts.set(name, {
      http: ctx.http,
      address,
      apiKey: await apiKeyFor(ctx, name),
      logger: ctx.logger,
      now: ctx.now,
    });
  }
  return contexts;
}

function pageSize(ctx: ConnectorContext): number {
  const parsed = Number(ctx.config.pageSize ?? DEFAULT_PAGE_SIZE);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1000) : DEFAULT_PAGE_SIZE;
}

async function queryChain<T>(
  ctx: ConnectorContext,
  address: string,
  chain: EvmChain,
  operation: string,
  run: (provider: EvmDataProvider, context: EvmProviderContext) => Promise<T>,
): Promise<T> {
  const contexts = await buildContexts(ctx, address);
  const order = providerOrder(ctx);
  const result = await DEFAULT_REGISTRY.query<T>({
    chain,
    ...(order ? { order } : {}),
    operation,
    context: (provider) => contexts.get(provider.name) as EvmProviderContext,
    run: (provider, context) => run(provider, context),
  });
  return result.value;
}

/* --------------------------------------------------------- pagination */

interface ChainActivity {
  readonly transfers: EvmTokenTransfer[];
  readonly transactions: EvmTransaction[];
  readonly lastBlock: number | null;
}

function trackBlock(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null || candidate > current) return candidate;
  return current;
}

async function collectChainActivity(
  ctx: ConnectorContext,
  address: string,
  chain: EvmChain,
  startBlock: number | null,
): Promise<ChainActivity> {
  const size = pageSize(ctx);
  const transfers: EvmTokenTransfer[] = [];
  const transactions: EvmTransaction[] = [];
  let lastBlock: number | null = null;

  let page = 1;
  let hasMoreTransfers = true;
  while (hasMoreTransfers && page <= MAX_PAGES) {
    const result = await queryChain<EvmPage<EvmTokenTransfer>>(ctx, address, chain, 'getTokenTransfers', (provider, context) =>
      provider.getTokenTransfers(context, chain, { page, pageSize: size, startBlock: startBlock ?? 0 }),
    );
    for (const transfer of result.items) {
      transfers.push(transfer);
      lastBlock = trackBlock(lastBlock, transfer.blockNumber);
    }
    hasMoreTransfers = result.hasMore;
    page += 1;
  }

  let txPage = 1;
  let hasMoreTransactions = true;
  while (hasMoreTransactions && txPage <= MAX_PAGES) {
    const result = await queryChain<EvmPage<EvmTransaction>>(ctx, address, chain, 'getTransactions', (provider, context) =>
      provider.getTransactions(context, chain, { page: txPage, pageSize: size, startBlock: startBlock ?? 0 }),
    );
    for (const transaction of result.items) {
      transactions.push(transaction);
      lastBlock = trackBlock(lastBlock, transaction.blockNumber);
    }
    hasMoreTransactions = result.hasMore;
    txPage += 1;
  }

  return { transfers, transactions, lastBlock };
}

/* ------------------------------------------------- normalisation on-chain */

function chainNormalizer(ctx: ConnectorContext, accountId: string, chain: EvmChain) {
  const stakingContracts = splitList(ctx.config.stakingContracts);
  return {
    accountId,
    address: accountId,
    chain,
    ...(stakingContracts.length > 0 ? { stakingContracts } : {}),
    rawSourceType: RAW_SOURCE_API,
    onSkip: (reason: string) => ctx.logger.warn(`[metamask] ${redact(reason)}`),
  };
}

/* ---------------------------------------------- import JSON (repli fichier) */

interface AddressJsonToken {
  readonly contractAddress?: string;
  readonly symbol?: string;
  readonly name?: string;
  readonly decimals?: number | string;
  readonly quantity?: number | string;
  readonly chain?: string;
}

interface AddressJsonTransaction {
  readonly externalTransactionId?: string;
  readonly date?: string;
  readonly type?: string;
  readonly direction?: string;
  readonly from?: string;
  readonly to?: string;
  readonly symbol?: string;
  readonly contractAddress?: string;
  readonly decimals?: number | string;
  readonly quantity?: number | string;
  readonly amount?: number | string;
  readonly currency?: string;
  readonly description?: string;
}

interface AddressJson {
  readonly address?: string;
  readonly chain?: string;
  readonly nativeBalance?: number | string;
  readonly tokens?: readonly AddressJsonToken[];
  readonly transactions?: readonly AddressJsonTransaction[];
}

function parseAddressJsonObject(
  doc: AddressJson,
  accountId: string,
  acc: ReturnType<typeof createAccumulator>,
): void {
  const chain = doc.chain ?? 'ethereum';

  for (const token of doc.tokens ?? []) {
    const quantity = typeof token.quantity === 'string' ? Number(token.quantity) : token.quantity;
    if (quantity === undefined || quantity === null || !Number.isFinite(Number(quantity))) {
      rejectRow(acc, 0, `Jeton « ${token.symbol ?? '?'} » sans quantité exploitable : position ignorée.`);
      continue;
    }
    const decimals = Number(token.decimals ?? 18);
    pushPosition(acc, {
      accountId,
      name: token.name ?? token.symbol ?? 'Jeton',
      symbol: token.symbol?.toUpperCase() ?? null,
      isin: null,
      contractAddress: token.contractAddress?.toLowerCase() ?? null,
      externalAssetId: token.contractAddress?.toLowerCase() ?? null,
      decimals: Number.isFinite(decimals) ? decimals : 18,
      kind: 'CRYPTO',
      chain: token.chain ?? chain,
      quantity: Math.abs(Number(quantity)),
      unitPrice: null,
      currency: (token.symbol ?? 'TOKEN').toUpperCase(),
      rawSourceType: RAW_SOURCE_JSON,
    });
  }

  (doc.transactions ?? []).forEach((tx, index) => {
    const line = index + 1;
    const symbol = (tx.symbol ?? tx.currency ?? 'TOKEN').toUpperCase();
    const quantityRaw = tx.quantity;
    const quantity = quantityRaw === undefined || quantityRaw === null ? null : Math.abs(Number(quantityRaw));
    const amountRaw = tx.amount;
    let amount = amountRaw === undefined || amountRaw === null ? null : Number(amountRaw);

    if (amount === null && quantity !== null && Number.isFinite(quantity)) {
      const incoming =
        (tx.direction ?? '').toUpperCase() === 'IN' ||
        ((tx.to ?? '').toLowerCase() === accountId && !(tx.direction ?? ''));
      amount = incoming ? quantity : -quantity;
      warnOnce(
        acc,
        'Export JSON EVM : montant absent sur au moins une transaction, reconstruit à partir de la ' +
          'quantité et du sens (réception = positif, envoi = négatif).',
      );
    }
    if (amount === null || !Number.isFinite(amount)) {
      rejectRow(acc, line, `Transaction EVM sans montant exploitable (jeton ${symbol}).`);
      return;
    }
    if (!tx.date) {
      rejectRow(acc, line, `Transaction EVM sans date (jeton ${symbol}).`);
      return;
    }

    const type = (tx.type ?? 'CRYPTO_TRANSFER') as ActivityType;
    pushActivity(acc, {
      accountId,
      date: tx.date,
      type,
      description: tx.description ?? `Transfert ${symbol}`,
      amount,
      currency: symbol,
      rawSourceType: RAW_SOURCE_JSON,
      externalTransactionId: tx.externalTransactionId ?? null,
      externalAssetId: tx.contractAddress?.toLowerCase() ?? null,
      quantity: quantity !== null && Number.isFinite(quantity) ? quantity : null,
      unitPrice: null,
      fees: 0,
      taxes: 0,
    });
  });
}

export const metamaskAddressJsonFormat: ImportFormat = {
  id: 'metamask-address-json',
  label: 'Wallet EVM — export JSON (adresse publique, format SuiviInvest)',
  kind: 'JSON',
  detect(content: string): number {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
      const doc = parsed as AddressJson;
      let score = 0;
      if (typeof doc.address === 'string' && ADDRESS_PATTERN.test(doc.address)) score += 0.5;
      if (Array.isArray(doc.tokens)) score += 0.25;
      if (Array.isArray(doc.transactions)) score += 0.25;
      if (typeof doc.chain === 'string') score += 0.1;
      return Math.min(score, 1);
    } catch {
      return 0;
    }
  },
  parse(content: string, options: ImportParseOptions = {}): ImportParseResult {
    const acc = createAccumulator();
    let doc: AddressJson;
    try {
      doc = JSON.parse(content) as AddressJson;
    } catch (error) {
      const message = error instanceof Error ? redact(error.message) : 'erreur de parsing';
      rejectRow(acc, 0, `JSON invalide : ${message}`);
      return toResult(acc, [], []);
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      rejectRow(acc, 0, 'Le document doit être un objet JSON { address, tokens, transactions }.');
      return toResult(acc, [], []);
    }

    const accountId =
      options.defaultAccountExternalId ?? (doc.address ? doc.address.toLowerCase() : 'evm-wallet');
    parseAddressJsonObject(doc, accountId, acc);

    return toResult(acc, Object.keys(doc), []);
  },
};

/* -------------------------------------------------------------- connecteur */

function accountOf(address: string, currency: string): NormalizedAccount {
  return {
    externalAccountId: address,
    name: `Wallet ${address.slice(0, 6)}…${address.slice(-4)}`,
    type: 'CRYPTO',
    currency,
    rawSourceType: 'evm.eoa',
    balance: null,
    isActive: true,
  };
}

export const metamaskConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Wallet EVM (MetaMask)',
  capabilities: {
    accounts: true,
    balances: true,
    positions: true,
    transactions: true,
    income: false, // revenus on-chain non interprétés : on ne devine pas.
    api: true, // chemin API public implémenté (lecture d'adresse publique uniquement).
  },
  importFormats: [metamaskAddressJsonFormat],
  requiredConfig: ['address'],
  // Aucun secret REQUIS : la lecture d'une adresse publique n'exige aucune clé.
  // Une clé d'explorateur OPTIONNELLE peut être fournie (voir PROVIDER_SECRETS).
  requiredSecrets: [],

  async testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult> {
    try {
      const address = requireAddress(ctx);
      const chains = configuredChains(ctx);
      if (chains.length === 0) {
        return {
          ok: false,
          status: 'DISCONNECTED',
          message: 'Aucune chaîne EVM reconnue dans la configuration.',
          requiresUserAction: false,
        };
      }
      const first = chains[0] as EvmChain;
      const balance = await queryChain(ctx, address, first, 'getNativeBalance', (provider, context) =>
        provider.getNativeBalance(context, first),
      );
      return {
        ok: true,
        status: 'CONNECTED',
        message:
          `Adresse publique lue : solde natif ${balance.quantity} ${balance.symbol} sur ${first.name} ` +
          `(${chains.length} chaîne(s) configurée(s), lecture seule).`,
        requiresUserAction: false,
      };
    } catch (error) {
      if (error instanceof ConnectorError) {
        return { ok: false, status: error.status, message: error.message, requiresUserAction: error.requiresUserAction };
      }
      throw error;
    }
  },

  async syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]> {
    const address = requireAddress(ctx);
    const chains = configuredChains(ctx);
    const currency = chains[0]?.nativeSymbol ?? 'ETH';
    return [accountOf(address, currency)];
  },

  async syncBalances(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]> {
    const address = requireAddress(ctx);
    const chains = configuredChains(ctx);
    const date = ctx.now().toISOString().slice(0, 10);
    const first = chains[0];
    if (!first) return [];
    const targets = accounts.length > 0 ? accounts : [accountOf(address, first.nativeSymbol)];
    if (chains.length > 1) {
      // Une ligne de trésorerie ne porte qu'une devise : on expose le natif de la
      // chaîne principale ; les autres soldes natifs sont des positions.
      ctx.logger.warn(
        `Wallet multi-chaînes : la trésorerie ne reflète que le solde natif de ${first.name} ; ` +
          'les autres chaînes sont exposées en positions.',
      );
    }
    const balance = await queryChain(ctx, address, first, 'getNativeBalance', (provider, context) =>
      provider.getNativeBalance(context, first),
    );
    return targets.map((account) => ({
      externalAccountId: account.externalAccountId,
      date,
      cash: balance.quantity,
      currency: first.nativeSymbol,
      rawSourceType: 'evm.eoa',
    }));
  },

  async syncPositions(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]> {
    const address = requireAddress(ctx);
    const chains = configuredChains(ctx);
    const accountId = accounts[0]?.externalAccountId ?? address;
    const positions: NormalizedPosition[] = [];

    for (const chain of chains) {
      let nativeQuantity: number | null = null;
      try {
        const native = await queryChain(ctx, address, chain, 'getNativeBalance', (provider, context) =>
          provider.getNativeBalance(context, chain),
        );
        nativeQuantity = native.quantity;
      } catch (error) {
        ctx.logger.warn(
          `Solde natif indisponible sur ${chain.name} : ${redact(error instanceof Error ? error.message : 'erreur inconnue')}`,
        );
      }

      let tokens: readonly EvmTokenBalance[] = [];
      try {
        tokens = await queryChain(ctx, address, chain, 'getTokenBalances', (provider, context) =>
          provider.getTokenBalances(context, chain),
        );
      } catch (error) {
        ctx.logger.warn(
          `Jetons indisponibles sur ${chain.name} : ${redact(error instanceof Error ? error.message : 'erreur inconnue')}`,
        );
      }

      positions.push(...positionsFromBalances(chainNormalizer(ctx, accountId, chain), tokens, nativeQuantity));
    }

    return positions;
  },

  async syncTransactions(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }> {
    const address = requireAddress(ctx);
    const chains = configuredChains(ctx);
    const startBlocks = parseCursor(window.cursor);
    const items: NormalizedTransaction[] = [];
    const blocks: Record<string, number | null> = {};
    const failures: string[] = [];

    for (const chain of chains) {
      try {
        const activity = await collectChainActivity(ctx, address, chain, startBlocks[chain.id] ?? null);
        const normalized = normalizeChainActivity(chainNormalizer(ctx, address, chain), {
          transfers: activity.transfers,
          transactions: activity.transactions,
        });
        for (const transaction of normalized) {
          if (window.since && transaction.date < window.since) continue;
          items.push(transaction);
        }
        blocks[chain.id] = activity.lastBlock;
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : 'erreur inconnue');
        failures.push(`${chain.id}: ${message}`);
        ctx.logger.warn(`Chaîne ${chain.name} ignorée pour cette synchronisation (reprise ultérieure) : ${message}`);
      }
    }

    const seen = new Set<string>();
    const deduped: NormalizedTransaction[] = [];
    for (const transaction of items) {
      const key =
        transaction.externalTransactionId ?? `${transaction.date}|${transaction.type}|${transaction.amount}|${transaction.currency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(transaction);
    }

    if (chains.length > 0 && failures.length === chains.length) {
      throw new ConnectorError(
        PROVIDER_ID,
        'PROVIDER_DOWN',
        `Aucune chaîne n'a pu être synchronisée. Détail : ${failures.join(' | ')}`,
      );
    }

    return { items: deduped, cursor: { value: JSON.stringify(blocks) } };
  },

  async syncIncome(
    _ctx: ConnectorContext,
    _window: SyncWindow,
  ): Promise<readonly NormalizedIncome[]> {
    // Volontairement vide : aucune règle fiable pour identifier un revenu
    // on-chain (staking, airdrop) sans cotation ni registre de contrats.
    return [];
  },

  async getSyncStatus(ctx: ConnectorContext): Promise<SyncStatusReport> {
    try {
      const address = requireAddress(ctx);
      const chains = configuredChains(ctx);
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message: `Lecture seule de l'adresse publique ${address} sur ${chains.length} chaîne(s) : ${chains
          .map((chain) => chain.name)
          .join(', ')}.`,
        requiresUserAction: false,
      };
    } catch (error) {
      if (error instanceof ConnectorError) {
        return { status: error.status, lastSyncAt: null, message: error.message, requiresUserAction: false };
      }
      throw error;
    }
  },
};

function parseCursor(cursor: string | null | undefined): Record<string, number> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------ surface de test */

/** Suivi des chaînes supportées (introspection et rétro-compatibilité). */
export const SUPPORTED_CHAINS: readonly string[] = Object.keys(EVM_CHAINS);

export const DEFAULT_CHAIN = 'ethereum';

const CHAIN_ENDPOINTS: Readonly<
  Record<string, { readonly rpcUrl: string; readonly explorerUrl: string; readonly explorerKind: string }>
> = Object.fromEntries(
  Object.entries(EVM_CHAINS).map(([id, chain]) => [
    id,
    { rpcUrl: chain.rpcUrl, explorerUrl: chain.explorerUrl, explorerKind: chain.explorerKind },
  ]),
);

const FALLBACK_ENDPOINTS = CHAIN_ENDPOINTS[DEFAULT_CHAIN] as {
  rpcUrl: string;
  explorerUrl: string;
  explorerKind: string;
};

export const metamaskInternals = {
  ADDRESS_PATTERN,
  FORBIDDEN_CONFIG_KEYS,
  assertNoSigningMaterial,
  unitsToNumber,
  configuredChains,
  providerOrder,
  parseCursor,
  SUPPORTED_CHAINS,
  CHAIN_ENDPOINTS,
  DEFAULT_CHAIN,
  DEFAULT_ENDPOINTS: FALLBACK_ENDPOINTS,
  registry: DEFAULT_REGISTRY,
  pageSize,
};
