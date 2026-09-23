import { createHash, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { ConnectorError, redact, type ConnectorContext, type NormalizedAccount } from '../connector.ts';
import { createBalanceConnector, requireSecret, stableId, type Holding } from './crypto-common.ts';

/**
 * Plateformes d'échange crypto, par clé API en LECTURE SEULE.
 *
 * Chaque plateforme permet de créer une clé limitée à la consultation : c'est
 * la seule à fournir. Une clé qui autoriserait le trading ou les retraits
 * n'est jamais nécessaire, et l'application n'appelle aucune route d'ordre ni
 * de retrait (seulement : soldes, portefeuilles, épargne).
 *
 * Les secrets sont lus via `ctx.secrets` (chiffrés en base), jamais journalisés.
 */

function platformAccount(providerId: string, name: string, apiKey: string): NormalizedAccount {
  return {
    externalAccountId: stableId(providerId, apiKey),
    name,
    type: 'CRYPTO',
    currency: 'EUR',
    rawSourceType: `${providerId}.account`,
    balance: null,
    isActive: true,
  };
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ================================================================ Binance */

const BINANCE = 'binance';
const BINANCE_API = 'https://api.binance.com';

async function binanceSigned<T>(
  ctx: ConnectorContext,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const apiKey = requireSecret(BINANCE, await ctx.secrets.get('binance_api_key'), 'Clé API Binance');
  const apiSecret = requireSecret(BINANCE, await ctx.secrets.get('binance_api_secret'), 'Clé secrète Binance');
  const query = new URLSearchParams({ ...params, timestamp: String(ctx.now().getTime()), recvWindow: '10000' });
  const signature = createHmac('sha256', apiSecret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  const response = await ctx.http.request(`${BINANCE_API}${path}?${query.toString()}`, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  if (response.status === 451) {
    throw new ConnectorError(BINANCE, 'PROVIDER_DOWN', 'Binance refuse les connexions depuis la localisation de ce serveur.');
  }
  if (response.status >= 400) {
    let message = `HTTP ${response.status}`;
    try {
      const body = JSON.parse(response.text) as { code?: number; msg?: string };
      message = body.msg ?? message;
      // -2014/-2015 : clé invalide, IP non autorisée ou droits insuffisants.
      if (body.code === -2014 || body.code === -2015 || body.code === -1022) {
        throw new ConnectorError(BINANCE, 'AUTH_REQUIRED', `Clé Binance refusée : ${message}`);
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
    }
    throw new ConnectorError(BINANCE, 'PROVIDER_BROKEN', `Binance ${path} : ${redact(message)}`);
  }
  return JSON.parse(response.text) as T;
}

export const binanceConnector = createBalanceConnector({
  id: BINANCE,
  displayName: 'Binance',
  requiredConfig: [],
  requiredSecrets: ['binance_api_key', 'binance_api_secret'],
  rawSourceType: 'binance.account',

  async account(ctx) {
    const apiKey = requireSecret(BINANCE, await ctx.secrets.get('binance_api_key'), 'Clé API Binance');
    return platformAccount(BINANCE, 'Binance', apiKey);
  },

  async holdings(ctx) {
    const holdings: Holding[] = [];
    const account = await binanceSigned<{ balances: { asset: string; free: string; locked: string }[] }>(
      ctx,
      'GET',
      '/api/v3/account',
      { omitZeroBalances: 'true' },
    );

    // Épargne flexible / bloquée (Simple Earn) et portefeuille de financement :
    // facultatifs, une clé sans ces droits ne bloque pas la synchro.
    let earnRead = false;
    try {
      const flexible = await binanceSigned<{ rows: { asset: string; totalAmount: string }[] }>(
        ctx, 'GET', '/sapi/v1/simple-earn/flexible/position', { size: '100' },
      );
      for (const row of flexible.rows) holdings.push({ symbol: row.asset, quantity: toNumber(row.totalAmount) });
      const locked = await binanceSigned<{ rows: { asset: string; amount: string }[] }>(
        ctx, 'GET', '/sapi/v1/simple-earn/locked/position', { size: '100' },
      );
      for (const row of locked.rows) holdings.push({ symbol: row.asset, quantity: toNumber(row.amount) });
      earnRead = true;
    } catch (error) {
      ctx.logger.warn(`Épargne Binance non lue : ${redact(error instanceof Error ? error.message : String(error))}`);
    }
    try {
      const funding = await binanceSigned<{ asset: string; free: string; locked: string; freeze: string }[]>(
        ctx, 'POST', '/sapi/v1/asset/get-funding-asset',
      );
      for (const row of funding) {
        holdings.push({ symbol: row.asset, quantity: toNumber(row.free) + toNumber(row.locked) + toNumber(row.freeze) });
      }
    } catch (error) {
      ctx.logger.warn(`Portefeuille de financement Binance non lu : ${redact(error instanceof Error ? error.message : String(error))}`);
    }

    for (const balance of account.balances) {
      // « LDxxx » : ancienne représentation de l'épargne flexible dans le spot.
      // Déjà comptée via Simple Earn quand celui-ci a pu être lu.
      if (/^LD[A-Z0-9]{2,}$/.test(balance.asset)) {
        if (earnRead) continue;
        holdings.push({ symbol: balance.asset.slice(2), quantity: toNumber(balance.free) + toNumber(balance.locked) });
        continue;
      }
      holdings.push({ symbol: balance.asset, quantity: toNumber(balance.free) + toNumber(balance.locked) });
    }
    return holdings;
  },
});

/* ================================================================= Kraken */

const KRAKEN = 'kraken';

/** Codes historiques Kraken → symbole usuel. */
const KRAKEN_ASSETS: Readonly<Record<string, string>> = {
  XXBT: 'BTC', XBT: 'BTC', XBTC: 'BTC', XETH: 'ETH', XXDG: 'DOGE', XDG: 'DOGE', XXRP: 'XRP', XLTC: 'LTC',
  XXLM: 'XLM', XETC: 'ETC', XZEC: 'ZEC', XXMR: 'XMR', XREP: 'REP', XMLN: 'MLN',
  ZEUR: 'EUR', ZUSD: 'USD', ZGBP: 'GBP', ZCAD: 'CAD', ZJPY: 'JPY', ZCHF: 'CHF', ZAUD: 'AUD',
};

/** « XXBT » → BTC, « ETH.F » (épargne) → ETH, « DOT.S » (staking) → DOT. */
export function krakenSymbol(code: string): string {
  const base = code.split('.')[0] ?? code;
  const mapped = KRAKEN_ASSETS[base];
  if (mapped) return mapped;
  // Suffixes d'épargne/staking accolés : ETH2, USDC.M déjà traités par le point.
  if (base === 'ETH2') return 'ETH';
  return base;
}

export function krakenSignature(path: string, nonce: string, body: string, secretBase64: string): string {
  const hash = createHash('sha256').update(nonce + body).digest();
  return createHmac('sha512', Buffer.from(secretBase64, 'base64'))
    .update(Buffer.concat([Buffer.from(path), hash]))
    .digest('base64');
}

export const krakenConnector = createBalanceConnector({
  id: KRAKEN,
  displayName: 'Kraken',
  requiredConfig: [],
  requiredSecrets: ['kraken_api_key', 'kraken_api_secret'],
  rawSourceType: 'kraken.account',

  async account(ctx) {
    const apiKey = requireSecret(KRAKEN, await ctx.secrets.get('kraken_api_key'), 'Clé API Kraken');
    return platformAccount(KRAKEN, 'Kraken', apiKey);
  },

  async holdings(ctx) {
    const apiKey = requireSecret(KRAKEN, await ctx.secrets.get('kraken_api_key'), 'Clé API Kraken');
    const apiSecret = requireSecret(KRAKEN, await ctx.secrets.get('kraken_api_secret'), 'Clé privée Kraken');
    const path = '/0/private/Balance';
    const nonce = String(ctx.now().getTime() * 1000);
    const body = `nonce=${nonce}`;
    const response = await ctx.http.json<{ error: string[]; result?: Record<string, string> }>(
      `https://api.kraken.com${path}`,
      {
        method: 'POST',
        body,
        headers: {
          'API-Key': apiKey,
          'API-Sign': krakenSignature(path, nonce, body, apiSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    if (response.error.length > 0) {
      const message = response.error.join(', ');
      if (/Invalid key|Invalid signature|Permission denied|Invalid nonce/i.test(message)) {
        throw new ConnectorError(
          KRAKEN,
          'AUTH_REQUIRED',
          `Clé Kraken refusée (${message}). Elle doit avoir le droit « Query Funds ».`,
        );
      }
      throw new ConnectorError(KRAKEN, 'PROVIDER_BROKEN', `Kraken : ${message}`);
    }
    return Object.entries(response.result ?? {}).map(([code, amount]) => ({
      symbol: krakenSymbol(code),
      quantity: toNumber(amount),
    }));
  },
});

/* =============================================================== Coinbase */

const COINBASE = 'coinbase';
const COINBASE_HOST = 'api.coinbase.com';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * JWT d'authentification Coinbase (clés « CDP »). Clés ECDSA (PEM, ES256) ou
 * Ed25519 (base64 de 64 octets, EdDSA), les deux formats proposés par Coinbase.
 */
export function coinbaseJwt(keyName: string, privateKey: string, method: string, path: string, now: Date): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const payload = {
    sub: keyName,
    iss: 'cdp',
    nbf: nowSeconds,
    exp: nowSeconds + 120,
    uri: `${method} ${COINBASE_HOST}${path}`,
  };
  const pem = privateKey.replace(/\\n/g, '\n').trim();
  const isPem = pem.includes('BEGIN');
  const header = { alg: isPem ? 'ES256' : 'EdDSA', kid: keyName, nonce: randomBytes(16).toString('hex'), typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  let signature: Buffer;
  if (isPem) {
    signature = sign('sha256', Buffer.from(signingInput), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  } else {
    const raw = Buffer.from(pem, 'base64');
    if (raw.length !== 64 && raw.length !== 32) {
      throw new ConnectorError(COINBASE, 'AUTH_REQUIRED', 'Clé privée Coinbase illisible : collez la clé telle que fournie par Coinbase.');
    }
    const seed = raw.subarray(0, 32);
    const key = createPrivateKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        d: seed.toString('base64url'),
        ...(raw.length === 64 ? { x: raw.subarray(32).toString('base64url') } : {}),
      },
      format: 'jwk',
    });
    signature = sign(null, Buffer.from(signingInput), key);
  }
  return `${signingInput}.${signature.toString('base64url')}`;
}

interface CoinbaseAccountsPage {
  readonly accounts: {
    readonly currency: string;
    readonly available_balance?: { value: string };
    readonly hold?: { value: string };
  }[];
  readonly has_next: boolean;
  readonly cursor?: string;
}

export const coinbaseConnector = createBalanceConnector({
  id: COINBASE,
  displayName: 'Coinbase',
  requiredConfig: [],
  requiredSecrets: ['coinbase_api_key_name', 'coinbase_api_private_key'],
  rawSourceType: 'coinbase.account',

  async account(ctx) {
    const keyName = requireSecret(COINBASE, await ctx.secrets.get('coinbase_api_key_name'), 'Nom de la clé API Coinbase');
    return platformAccount(COINBASE, 'Coinbase', keyName);
  },

  async holdings(ctx) {
    const keyName = requireSecret(COINBASE, await ctx.secrets.get('coinbase_api_key_name'), 'Nom de la clé API Coinbase');
    const privateKey = requireSecret(COINBASE, await ctx.secrets.get('coinbase_api_private_key'), 'Clé privée Coinbase');
    const holdings: Holding[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const path = '/api/v3/brokerage/accounts';
      const query = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      let jwt: string;
      try {
        jwt = coinbaseJwt(keyName, privateKey, 'GET', path, ctx.now());
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError(COINBASE, 'AUTH_REQUIRED', 'Clé privée Coinbase illisible : vérifiez le copier-coller.');
      }
      const response = await ctx.http.json<CoinbaseAccountsPage>(`https://${COINBASE_HOST}${path}${query}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      for (const account of response.accounts ?? []) {
        holdings.push({
          symbol: account.currency,
          quantity: toNumber(account.available_balance?.value) + toNumber(account.hold?.value),
        });
      }
      if (!response.has_next || !response.cursor) break;
      cursor = response.cursor;
    }
    return holdings;
  },
});

/* =============================================================== Bitpanda */

const BITPANDA = 'bitpanda';

interface BitpandaWallet {
  readonly id?: string;
  readonly type?: string;
  readonly attributes?: {
    readonly cryptocoin_symbol?: string;
    readonly fiat_symbol?: string;
    readonly balance?: string;
    readonly name?: string;
    readonly deleted?: boolean;
  };
}

/** Parcourt la réponse `asset-wallets` (crypto, métaux, indices…) et en extrait les portefeuilles. */
export function collectBitpandaWallets(node: unknown, out: Map<string, BitpandaWallet> = new Map()): Map<string, BitpandaWallet> {
  if (Array.isArray(node)) {
    for (const item of node) collectBitpandaWallets(item, out);
  } else if (node !== null && typeof node === 'object') {
    const candidate = node as BitpandaWallet;
    const attributes = candidate.attributes;
    if (attributes && typeof attributes.balance === 'string' && (attributes.cryptocoin_symbol || attributes.fiat_symbol)) {
      out.set(candidate.id ?? `${attributes.cryptocoin_symbol ?? attributes.fiat_symbol}-${out.size}`, candidate);
    }
    for (const value of Object.values(node)) collectBitpandaWallets(value, out);
  }
  return out;
}

export const bitpandaConnector = createBalanceConnector({
  id: BITPANDA,
  displayName: 'Bitpanda',
  requiredConfig: [],
  requiredSecrets: ['bitpanda_api_key'],
  rawSourceType: 'bitpanda.account',

  async account(ctx) {
    const apiKey = requireSecret(BITPANDA, await ctx.secrets.get('bitpanda_api_key'), 'Clé API Bitpanda');
    return platformAccount(BITPANDA, 'Bitpanda', apiKey);
  },

  async holdings(ctx) {
    const apiKey = requireSecret(BITPANDA, await ctx.secrets.get('bitpanda_api_key'), 'Clé API Bitpanda');
    const headers = { 'X-Api-Key': apiKey };
    const wallets = new Map<string, BitpandaWallet>();
    try {
      collectBitpandaWallets(await ctx.http.json<unknown>('https://api.bitpanda.com/v1/asset-wallets', { headers }), wallets);
    } catch (error) {
      if (error instanceof ConnectorError && error.kind === 'AUTH_REQUIRED') throw error;
      ctx.logger.warn(`Portefeuilles d'actifs Bitpanda non lus, repli sur les wallets crypto : ${redact(String(error))}`);
      collectBitpandaWallets(await ctx.http.json<unknown>('https://api.bitpanda.com/v1/wallets', { headers }), wallets);
    }
    try {
      collectBitpandaWallets(await ctx.http.json<unknown>('https://api.bitpanda.com/v1/fiatwallets', { headers }), wallets);
    } catch (error) {
      ctx.logger.warn(`Portefeuilles en euros Bitpanda non lus : ${redact(String(error))}`);
    }

    // Cotations EUR publiques de Bitpanda : couvrent aussi ses métaux et indices.
    let ticker: Record<string, { EUR?: string }> = {};
    try {
      ticker = await ctx.http.json<Record<string, { EUR?: string }>>('https://api.bitpanda.com/v1/ticker');
    } catch (error) {
      ctx.logger.warn(`Cotations Bitpanda indisponibles : ${redact(String(error))}`);
    }

    const holdings: Holding[] = [];
    for (const wallet of wallets.values()) {
      const attributes = wallet.attributes;
      if (!attributes || attributes.deleted) continue;
      const symbol = attributes.cryptocoin_symbol ?? attributes.fiat_symbol ?? '';
      const quantity = toNumber(attributes.balance);
      if (symbol === '' || quantity <= 0) continue;
      const price = toNumber(ticker[symbol]?.EUR);
      holdings.push({
        symbol,
        quantity,
        ...(attributes.name ? { name: attributes.name } : {}),
        ...(price > 0 ? { priceEur: price } : {}),
      });
    }
    return holdings;
  },
});
