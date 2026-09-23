import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { ConnectorError, type ConnectorContext, type NormalizedAccount } from '../connector.ts';
import { createBalanceConnector, stableId, type Holding } from './crypto-common.ts';

/**
 * Wallet Bitcoin, en lecture seule.
 *
 * Accepte des adresses (1…, 3…, bc1…) et/ou une clé publique étendue — xpub,
 * ypub ou zpub — telle qu'affichée par Ledger Live, Trezor Suite, Sparrow ou
 * Electrum. Une clé PUBLIQUE étendue permet de retrouver toutes les adresses du
 * compte, mais ne permet PAS de dépenser : c'est l'équivalent d'un relevé.
 * Une clé privée (xprv…) ou une phrase de récupération est refusée.
 *
 * Soldes lus sur l'explorateur public mempool.space (repli : blockstream.info).
 */

const PROVIDER_ID = 'bitcoin';
const GAP_LIMIT = 20;
const MAX_ADDRESSES_PER_CHAIN = 400;
const EXPLORERS = ['https://mempool.space/api', 'https://blockstream.info/api'] as const;

type ScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';

/** Préfixes de version des clés publiques étendues (mainnet). */
const EXTENDED_VERSIONS: Readonly<Record<string, { version: number; script: ScriptType }>> = {
  xpub: { version: 0x0488b21e, script: 'p2pkh' },
  ypub: { version: 0x049d7cb2, script: 'p2sh-p2wpkh' },
  zpub: { version: 0x04b24746, script: 'p2wpkh' },
};

const b58 = base58check(sha256);

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

export function addressFromPublicKey(publicKey: Uint8Array, script: ScriptType): string {
  const pkh = hash160(publicKey);
  if (script === 'p2wpkh') return bech32.encode('bc', [0, ...bech32.toWords(pkh)]);
  if (script === 'p2pkh') return b58.encode(Uint8Array.from([0x00, ...pkh]));
  const redeem = Uint8Array.from([0x00, 0x14, ...pkh]);
  return b58.encode(Uint8Array.from([0x05, ...hash160(redeem)]));
}

/** Adresse `index` de la branche `change` (0 = réception, 1 = monnaie rendue). */
export function deriveAddress(extendedKey: string, change: 0 | 1, index: number): string {
  const prefix = extendedKey.slice(0, 4);
  const spec = EXTENDED_VERSIONS[prefix];
  if (!spec) throw new ConnectorError(PROVIDER_ID, 'DATA', `Clé étendue non reconnue (${prefix}…).`);
  const node = HDKey.fromExtendedKey(extendedKey, { public: spec.version, private: 0 }).deriveChild(change).deriveChild(index);
  if (!node.publicKey) throw new ConnectorError(PROVIDER_ID, 'DATA', 'Clé publique dérivée absente.');
  return addressFromPublicKey(node.publicKey, spec.script);
}

const ADDRESS_PATTERN = /^(bc1[02-9ac-hj-np-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/;
const EXTENDED_PATTERN = /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/;

export interface BitcoinSources {
  readonly addresses: readonly string[];
  readonly extendedKeys: readonly string[];
}

/** Lit la configuration : adresses et clés publiques étendues, séparées par virgules, espaces ou retours. */
export function parseBitcoinConfig(raw: string | undefined): BitcoinSources {
  const items = (raw ?? '').split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) {
    throw new ConnectorError(PROVIDER_ID, 'AUTH_REQUIRED', 'Ajoutez au moins une adresse Bitcoin ou une clé xpub/zpub.');
  }
  const addresses: string[] = [];
  const extendedKeys: string[] = [];
  for (const item of items) {
    if (/^[xyzt]prv/i.test(item) || item.split(' ').length >= 12) {
      throw new ConnectorError(
        PROVIDER_ID,
        'DATA',
        'Clé PRIVÉE refusée : collez uniquement la clé publique (xpub, ypub ou zpub) ou des adresses.',
      );
    }
    if (EXTENDED_PATTERN.test(item)) extendedKeys.push(item);
    else if (ADDRESS_PATTERN.test(item)) addresses.push(item);
    else throw new ConnectorError(PROVIDER_ID, 'DATA', `Adresse Bitcoin invalide : ${item.slice(0, 12)}…`);
  }
  return { addresses, extendedKeys };
}

interface AddressStats {
  readonly chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  readonly mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

async function addressStats(ctx: ConnectorContext, address: string): Promise<{ sats: number; used: boolean }> {
  let lastError: unknown = null;
  for (const base of EXPLORERS) {
    try {
      const stats = await ctx.http.json<AddressStats>(`${base}/address/${address}`);
      const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
      const pending = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
      return {
        sats: confirmed + pending,
        used: stats.chain_stats.tx_count + stats.mempool_stats.tx_count > 0,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new ConnectorError(
    PROVIDER_ID,
    'PROVIDER_DOWN',
    `Explorateurs Bitcoin injoignables (${lastError instanceof Error ? lastError.message : 'erreur inconnue'}).`,
  );
}

/** Parcourt les adresses d'une clé étendue jusqu'à 20 adresses vierges consécutives (norme BIP44). */
async function scanExtendedKey(ctx: ConnectorContext, extendedKey: string): Promise<number> {
  let total = 0;
  for (const change of [0, 1] as const) {
    let unused = 0;
    for (let index = 0; index < MAX_ADDRESSES_PER_CHAIN && unused < GAP_LIMIT; index++) {
      const { sats, used } = await addressStats(ctx, deriveAddress(extendedKey, change, index));
      total += sats;
      unused = used ? 0 : unused + 1;
    }
  }
  return total;
}

function configValue(ctx: ConnectorContext): string {
  return ctx.config.addresses ?? ctx.config.address ?? ctx.config.xpub ?? '';
}

export const bitcoinConnector = createBalanceConnector({
  id: PROVIDER_ID,
  displayName: 'Bitcoin',
  requiredConfig: ['addresses'],
  requiredSecrets: [],
  rawSourceType: 'bitcoin.wallet',

  async account(ctx): Promise<NormalizedAccount> {
    const raw = configValue(ctx);
    const sources = parseBitcoinConfig(raw);
    const first = sources.extendedKeys[0] ?? sources.addresses[0] ?? '';
    return {
      externalAccountId: stableId('btc', raw),
      name: `Bitcoin ${first.slice(0, 6)}…${first.slice(-4)}`,
      type: 'CRYPTO',
      currency: 'EUR',
      rawSourceType: 'bitcoin.wallet',
      balance: null,
      isActive: true,
    };
  },

  async holdings(ctx): Promise<readonly Holding[]> {
    const sources = parseBitcoinConfig(configValue(ctx));
    let sats = 0;
    for (const address of sources.addresses) sats += (await addressStats(ctx, address)).sats;
    for (const key of sources.extendedKeys) sats += await scanExtendedKey(ctx, key);
    return [{ symbol: 'BTC', name: 'Bitcoin', quantity: sats / 1e8, chain: 'bitcoin' }];
  },
});
