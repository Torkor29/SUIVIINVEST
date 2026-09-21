/**
 * État d'un wallet EVM pour l'interface (`WalletStatusDto`).
 *
 * Sources :
 *  - `accounts` : l'adresse publique et le compte CRYPTO ;
 *  - `chain_sync_state` : dernière synchro et dernier bloc PAR CHAÎNE ;
 *  - les activités déjà ingérées + le module market data existant : quantité de
 *    jetons détenus et valeur en EUR ;
 *  - `connections.last_error` : l'erreur éventuelle, TOUJOURS traduite en message
 *    compréhensible — jamais une trace technique (pas de pile, pas d'URL, pas de
 *    code interne).
 *
 * READ-ONLY : ce service ne lit que la base et des cours déjà enregistrés.
 */

import { computePositions, round, sum } from '@suiviinvest/core';
import type { WalletChainStatusDto, WalletStatusDto } from '@suiviinvest/api-contract';
import type { Db } from '../../db/database.ts';
import { AccountRepository, InstrumentRepository, type AccountRow } from '../../repositories/accounts.ts';
import { ActivityRepository, toDomainActivity } from '../../repositories/activities.ts';
import { ConnectionRepository } from '../../repositories/connections.ts';
import { MarketRepository } from '../../repositories/market.ts';

interface ChainSyncStateRow {
  connection_id: string;
  chain: string;
  address: string;
  last_block: number | null;
  last_synced_at: string | null;
  cursor: string | null;
}

/* ---------------------------------------------------- messages d'erreur */

const KIND_MESSAGES: Readonly<Record<string, string>> = {
  AUTH_REQUIRED: 'Une authentification est requise pour contacter le fournisseur. Vérifiez la configuration de la connexion.',
  MFA_REQUIRED: 'Une validation manuelle est requise chez le fournisseur. Relancez la synchronisation après validation.',
  SESSION_EXPIRED: 'La session a expiré : reconnectez la source pour reprendre la synchronisation.',
  RATE_LIMITED: 'Le fournisseur limite temporairement les accès : réessayez dans quelques minutes.',
  PROVIDER_BROKEN: 'Le fournisseur a modifié son service. Une autre source sera utilisée à la prochaine synchronisation.',
  PROVIDER_DOWN: 'Le service d’exploration est temporairement injoignable : réessayez plus tard.',
  NETWORK: 'Problème réseau pendant la synchronisation : vérifiez votre connexion, puis relancez.',
  DATA: 'Les données reçues étaient inexploitables. Relancez la synchronisation ; si le problème persiste, vérifiez l’adresse du wallet.',
  NOT_SUPPORTED: 'Aucun fournisseur n’est disponible pour ce wallet : configurez une clé d’API ou activez une chaîne exploitable.',
  SYNC_ERROR: 'La synchronisation a échoué. Relancez-la ; si le problème persiste, vérifiez la configuration du wallet.',
};

const GENERIC_ERROR =
  'La dernière synchronisation a échoué. Relancez-la ; si le problème persiste, vérifiez la configuration du wallet.';

const KIND_PATTERN = /\[[^\]/]*\/([A-Z_]+)\]/;

/**
 * Traduit une erreur de connexion en message utilisateur. Ne laisse JAMAIS
 * passer une trace technique : on n'extrait que le `kind` normalisé.
 */
export function humanizeWalletError(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  const match = KIND_PATTERN.exec(raw);
  if (match?.[1] && KIND_MESSAGES[match[1]]) return KIND_MESSAGES[match[1]] as string;

  const lowered = raw.toLowerCase();
  for (const [kind, message] of Object.entries(KIND_MESSAGES)) {
    if (lowered.includes(kind.toLowerCase().replace('_', ' ')) || lowered.includes(kind.toLowerCase())) {
      return message;
    }
  }
  return GENERIC_ERROR;
}

/* ------------------------------------------------------------- service */

export interface WalletStatusOptions {
  readonly now?: () => Date;
}

export class WalletStatusService {
  readonly #db: Db;
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #connections: ConnectionRepository;
  readonly #market: MarketRepository;

  constructor(db: Db, _options: WalletStatusOptions = {}) {
    this.#db = db;
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#connections = new ConnectionRepository(db);
    this.#market = new MarketRepository(db);
  }

  /** Tous les wallets EVM connus (comptes de type CRYPTO), les plus valorisés d'abord. */
  list(): WalletStatusDto[] {
    return this.#accounts
      .list()
      .filter((account) => account.type === 'CRYPTO')
      .map((account) => this.#build(account))
      .sort((a, b) => b.valueEur - a.valueEur);
  }

  forAccount(accountId: string): WalletStatusDto | null {
    const account = this.#accounts.get(accountId);
    if (!account || account.type !== 'CRYPTO') return null;
    return this.#build(account);
  }

  #chainStates(address: string): ChainSyncStateRow[] {
    if (!address) return [];
    return this.#db.all<ChainSyncStateRow>(
      'SELECT * FROM chain_sync_state WHERE lower(address) = ? ORDER BY chain',
      address.toLowerCase(),
    );
  }

  #build(account: AccountRow): WalletStatusDto {
    const address = account.external_account_id ?? '';
    const states = this.#chainStates(address);
    const rows = this.#activities.listForAccount(account.id);

    // Quantités détenues et valeur EUR via le module market data existant
    // (cours déjà enregistrés ; aucune valeur inventée si un prix manque).
    const latestQuotes = this.#market.latestQuotes();
    const lastPrices: Record<string, number> = {};
    const domain = rows.map((row) => toDomainActivity(row, account.currency));
    for (const activity of domain) {
      if (!activity.instrumentId) continue;
      const quote = latestQuotes.get(activity.instrumentId);
      if (quote) lastPrices[activity.instrumentId] = quote.close;
    }
    const calculation = computePositions({
      activities: domain,
      lastPrices,
      currency: account.currency,
    });

    const assets = calculation.positions
      .filter((position) => position.quantity > 0)
      .map((position) => {
        const instrument = position.instrumentId ? this.#instruments.get(position.instrumentId) : null;
        return {
          chain: instrument?.chain ?? 'unknown',
          symbol: instrument?.symbol ?? position.instrumentId,
          valueEur: round(position.marketValue),
        };
      });

    const valueTotal = round(sum(assets.map((asset) => asset.valueEur)));

    const chainIds = new Set<string>();
    for (const state of states) chainIds.add(state.chain);
    for (const asset of assets) if (asset.chain !== 'unknown') chainIds.add(asset.chain);

    const chains: WalletChainStatusDto[] = [...chainIds].sort().map((chain) => {
      const state = states.find((candidate) => candidate.chain === chain);
      const chainAssets = assets.filter((asset) => asset.chain === chain);
      return {
        chain,
        tokens: chainAssets.length,
        valueEur: round(sum(chainAssets.map((asset) => asset.valueEur))),
        lastSyncedAt: state?.last_synced_at ?? null,
        lastBlock: state?.last_block ?? null,
        // `chain_sync_state` ne stocke pas d'erreur par chaîne : l'erreur est
        // portée au niveau du wallet (message compréhensible plus bas).
        error: null,
      };
    });

    const lastSyncedAt =
      states
        .map((state) => state.last_synced_at)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ??
      rows
        .map((row) => row.last_synced_at)
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ??
      null;

    const connection = account.connection_id ? this.#connections.get(account.connection_id) : null;
    const error = humanizeWalletError(connection?.last_error ?? null);

    return {
      accountId: account.id,
      name: account.name,
      address,
      chains,
      // Comptage distinct : chaque jeton (ou solde natif) détenu compte une fois,
      // toutes chaînes confondues.
      tokenCount: assets.length,
      valueEur: valueTotal,
      lastSyncedAt,
      error,
    };
  }
}
