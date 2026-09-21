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
 *    des historiques via des appels JSON-RPC/HTTP publics.
 *  - `capabilities.income = false` : les revenus on-chain ne sont pas
 *    interprétés ici, on ne devine pas.
 *
 * ---------------------------------------------------------------------------
 * VÉRIFICATION DES POINTS D'ENTRÉE : UNVERIFIED — à ajuster quand le format
 * officieux est confirmé.
 *
 *  - Solde natif : JSON-RPC `eth_getBalance` (standard EVM, stable par nature).
 *    L'URL par défaut (`https://cloudflare-eth.com`) est un service public NON
 *    contractuel : à surcharger via `config.rpcUrl`.
 *  - Jetons ERC-20 : API compatible Etherscan (`module=account&action=tokentx`).
 *    Le point d'entrée par défaut `https://api.etherscan.io/api` exige
 *    aujourd'hui une clé d'API pour la plupart des réseaux ; elle est lue de
 *    façon OPTIONNELLE dans les secrets (`explorerApiKey`) et n'est jamais
 *    journalisée. À surcharger via `config.explorerUrl` (ex. instance Blockscout
 *    compatible). Le nom des champs de réponse (`tokenSymbol`, `tokenDecimal`,
 *    `logIndex`...) suit la réponse Etherscan v1 et n'a pas été rejoué contre
 *    une réponse réelle ici.
 *
 * Tout échec de forme (réponse non JSON, `result` non tableau) devient une
 * `ConnectorError` explicite plutôt qu'un tableau vide silencieux.
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
import { round, type ActivityType } from '@suiviinvest/core';
import {
  createAccumulator,
  pushActivity,
  pushPosition,
  rejectRow,
  toResult,
  warnOnce,
} from './shared.ts';

const PROVIDER_ID = 'metamask' as const;
const RAW_SOURCE_API = 'evm.explorer_api';
const RAW_SOURCE_JSON = 'evm.address_json';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_RPC_URL = 'https://cloudflare-eth.com';
const DEFAULT_EXPLORER_URL = 'https://api.etherscan.io/api';

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
          'Ce connecteur est en LECTURE SEULE et n\'accepte qu\'une adresse publique.',
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

function rpcUrl(ctx: ConnectorContext): string {
  return (ctx.config.rpcUrl ?? '').trim() || DEFAULT_RPC_URL;
}

function explorerUrl(ctx: ConnectorContext): string {
  return (ctx.config.explorerUrl ?? '').trim() || DEFAULT_EXPLORER_URL;
}

/* ------------------------------------------------------------ conversions */

/** Convertit une quantité en base units (hex `0x…` ou décimal) vers un nombre décimal. */
export function unitsToNumber(raw: string, decimals: number): number | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    // Etherscan renvoie des entiers DÉCIMAUX pour `value`, le JSON-RPC des
    // valeurs HEXADÉCIMALES : les deux notations sont acceptées par BigInt.
    const value = BigInt(text);
    if (value < 0n) return null;
    return bigintToNumber(value, decimals);
  } catch {
    return null;
  }
}

function bigintToNumber(value: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  return round(Number(whole) + Number(fraction) / Number(base), 8);
}

/* --------------------------------------------------------------- réseau */

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string };
}

/** Solde natif en ETH (en lecture seule : `eth_getBalance`). */
async function fetchNativeBalance(ctx: ConnectorContext, address: string): Promise<number> {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getBalance',
    params: [address, 'latest'],
  };
  const response = await ctx.http.json<JsonRpcResponse>(rpcUrl(ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (response.error) {
    throw new ConnectorError(
      PROVIDER_ID,
      'PROVIDER_BROKEN',
      `Le nœud RPC a refusé eth_getBalance : ${redact(response.error.message ?? 'erreur inconnue')}`,
    );
  }
  if (typeof response.result !== 'string') {
    throw new ConnectorError(
      PROVIDER_ID,
      'PROVIDER_BROKEN',
      'Réponse RPC inattendue pour eth_getBalance (champ « result » absent ou non textuel).',
    );
  }
  const balance = unitsToNumber(response.result, 18);
  if (balance === null) {
    throw new ConnectorError(
      PROVIDER_ID,
      'DATA',
      `Solde natif illisible dans la réponse RPC : « ${redact(response.result)} »`,
    );
  }
  return balance;
}

interface TokenTransfer {
  readonly hash?: string;
  readonly logIndex?: string;
  readonly timeStamp?: string;
  readonly from?: string;
  readonly to?: string;
  readonly contractAddress?: string;
  readonly tokenName?: string;
  readonly tokenSymbol?: string;
  readonly tokenDecimal?: string;
  readonly value?: string;
}

interface ExplorerResponse {
  readonly status?: string;
  readonly message?: string;
  readonly result?: unknown;
}

async function fetchTokenTransfers(
  ctx: ConnectorContext,
  address: string,
): Promise<readonly TokenTransfer[]> {
  const params = new URLSearchParams({
    module: 'account',
    action: 'tokentx',
    address,
    page: '1',
    offset: '200',
    sort: 'asc',
  });
  const apiKey = await ctx.secrets.get('explorerApiKey');
  if (apiKey) params.set('apikey', apiKey);
  const url = `${explorerUrl(ctx)}?${params.toString()}`;

  const response = await ctx.http.json<ExplorerResponse>(url, { method: 'GET' });
  if (Array.isArray(response.result)) return response.result as readonly TokenTransfer[];

  const message = `${response.message ?? ''} ${String(response.result ?? '')}`;
  if (/no\s+transactions/i.test(message)) return [];

  throw new ConnectorError(
    PROVIDER_ID,
    'PROVIDER_BROKEN',
    `L'explorateur n'a pas renvoyé de liste de transferts : ${redact(message.trim() || 'réponse vide')}`,
  );
}

/* --------------------------------------------------------- normalisation */

function accountOf(address: string): NormalizedAccount {
  return {
    externalAccountId: address,
    name: `Wallet ${address.slice(0, 6)}…${address.slice(-4)}`,
    type: 'CRYPTO',
    currency: 'ETH',
    rawSourceType: 'evm.eoa',
    balance: null,
    isActive: true,
  };
}

function transferToTransaction(transfer: TokenTransfer, address: string): NormalizedTransaction | null {
  const decimals = Number(transfer.tokenDecimal ?? '0');
  const raw = transfer.value ?? '';
  const quantity = unitsToNumber(raw, Number.isFinite(decimals) ? decimals : 0);
  if (quantity === null) return null;

  const symbol = (transfer.tokenSymbol ?? 'TOKEN').toUpperCase();
  const incoming = (transfer.to ?? '').toLowerCase() === address;
  const timestamp = Number(transfer.timeStamp ?? '');
  const date = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString().slice(0, 10)
    : null;
  if (!date) return null;

  const signed = incoming ? quantity : -quantity;
  const contract = (transfer.contractAddress ?? '').toLowerCase() || null;

  return {
    externalAccountId: address,
    externalTransactionId: transfer.hash
      ? `${transfer.hash}:${transfer.logIndex ?? '0'}`
      : null,
    externalAssetId: contract,
    date,
    type: 'CRYPTO_TRANSFER',
    description: `${incoming ? 'Réception' : 'Envoi'} ${symbol} ${incoming ? 'de' : 'vers'} ${
      incoming ? transfer.from ?? '?' : transfer.to ?? '?'
    }`,
    quantity,
    unitPrice: null,
    // Faute de cotation on-chain, le montant est exprimé dans l'unité du jeton
    // (pas de conversion fiat inventée, pas de 0 trompeur).
    amount: signed,
    currency: symbol,
    fees: 0,
    taxes: 0,
    rawSourceType: RAW_SOURCE_API,
  };
}

/* ------------------------------------------------- import JSON (repli fichier) */

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

export const metamaskConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Wallet EVM (MetaMask)',
  capabilities: {
    accounts: true,
    balances: true,
    positions: true,
    transactions: true,
    income: false, // revenus on-chain non interprétés : on ne devine pas.
    api: true, // chemin API PUBLIC implémenté (lecture d'adresse publique uniquement).
  },
  importFormats: [metamaskAddressJsonFormat],
  requiredConfig: ['address'],
  // Aucun secret REQUIS : la lecture d'une adresse publique n'exige aucune clé.
  // Une clé d'explorateur optionnelle peut être fournie sous « explorerApiKey ».
  requiredSecrets: [],

  async testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult> {
    try {
      const address = requireAddress(ctx);
      const balance = await fetchNativeBalance(ctx, address);
      return {
        ok: true,
        status: 'CONNECTED',
        message: `Adresse publique lue : solde natif ${balance} ETH (lecture seule).`,
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
    return [accountOf(requireAddress(ctx))];
  },

  async syncBalances(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]> {
    const address = requireAddress(ctx);
    const date = ctx.now().toISOString().slice(0, 10);
    const native = await fetchNativeBalance(ctx, address);
    const targets = accounts.length > 0 ? accounts : [accountOf(address)];
    return targets.map((account) => ({
      externalAccountId: account.externalAccountId,
      date,
      // « Trésorerie » d'un wallet EVM = solde natif en ETH. Les jetons ERC-20
      // sont exposés séparément comme positions (aucune somme inventée).
      cash: native,
      currency: account.currency,
      rawSourceType: 'evm.eoa',
    }));
  },

  async syncPositions(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]> {
    const address = requireAddress(ctx);
    const accountId = accounts[0]?.externalAccountId ?? address;
    const transfers = await fetchTokenTransfers(ctx, address);
    const native = await fetchNativeBalance(ctx, address);

    const aggregated = new Map<string, { symbol: string; name: string; decimals: number; quantity: number }>();
    for (const transfer of transfers) {
      const contract = (transfer.contractAddress ?? '').toLowerCase();
      if (contract === '') continue;
      const decimals = Number(transfer.tokenDecimal ?? '18');
      const quantity = unitsToNumber(transfer.value ?? '0', Number.isFinite(decimals) ? decimals : 18);
      if (quantity === null) continue;
      const incoming = (transfer.to ?? '').toLowerCase() === address;
      const entry = aggregated.get(contract) ?? {
        symbol: (transfer.tokenSymbol ?? 'TOKEN').toUpperCase(),
        name: transfer.tokenName ?? transfer.tokenSymbol ?? 'Jeton',
        decimals: Number.isFinite(decimals) ? decimals : 18,
        quantity: 0,
      };
      entry.quantity = round(entry.quantity + (incoming ? quantity : -quantity), 8);
      aggregated.set(contract, entry);
    }

    const positions: NormalizedPosition[] = [];
    for (const [contract, entry] of aggregated) {
      if (entry.quantity <= 0) continue;
      positions.push({
        externalAccountId: accountId,
        externalAssetId: contract,
        isin: null,
        symbol: entry.symbol,
        name: entry.name,
        kind: 'CRYPTO',
        quantity: entry.quantity,
        unitPrice: null,
        currency: entry.symbol,
        chain: ctx.config.chain ?? 'ethereum',
        contractAddress: contract,
        decimals: entry.decimals,
        rawSourceType: RAW_SOURCE_API,
      });
    }

    if (native > 0) {
      positions.push({
        externalAccountId: accountId,
        externalAssetId: null,
        isin: null,
        symbol: 'ETH',
        name: 'Ether (solde natif)',
        kind: 'CRYPTO',
        quantity: native,
        unitPrice: null,
        currency: 'ETH',
        chain: ctx.config.chain ?? 'ethereum',
        contractAddress: null,
        decimals: 18,
        rawSourceType: RAW_SOURCE_API,
      });
    }

    return positions;
  },

  async syncTransactions(
    ctx: ConnectorContext,
    _window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }> {
    const address = requireAddress(ctx);
    const transfers = await fetchTokenTransfers(ctx, address);
    const items: NormalizedTransaction[] = [];
    for (const transfer of transfers) {
      const transaction = transferToTransaction(transfer, address);
      if (transaction) {
        items.push(transaction);
      } else {
        ctx.logger.warn(
          `Transfert ignoré (données incomplètes) : hash ${redact(transfer.hash ?? 'inconnu')}`,
        );
      }
    }
    const last = transfers.at(-1);
    return { items, cursor: { value: last?.hash ?? null } };
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
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message: `Lecture seule de l'adresse publique ${address}.`,
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

/** Surface interne exposée aux tests unitaires. */
export const metamaskInternals = {
  ADDRESS_PATTERN,
  FORBIDDEN_CONFIG_KEYS,
  assertNoSigningMaterial,
  unitsToNumber,
  transferToTransaction,
  DEFAULT_RPC_URL,
  DEFAULT_EXPLORER_URL,
};