import { computePositions, round, sum, WEALTH_CLASSES } from '@suiviinvest/core';
import type { AllocationSlice, CryptoAssetDto, CryptoResponse, CryptoWalletDto, PeriodKey } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository, InstrumentRepository } from '../repositories/accounts.ts';
import { ActivityRepository, toDomainActivity, ValuationRepository } from '../repositories/activities.ts';
import { ConnectionRepository } from '../repositories/connections.ts';
import { MarketRepository } from '../repositories/market.ts';
import { MANUAL_CRYPTO_ID } from './holdings.ts';

/**
 * Vue crypto.
 *
 * Aucune clé privée, aucune seed, aucune signature : un wallet est identifié par
 * son adresse publique, et le suivi fonctionne sans connexion permanente à
 * MetaMask.
 *
 * Source des positions, dans cet ordre :
 *  1. la DERNIÈRE POSITION COMMUNIQUÉE PAR LE CONNECTEUR (table `valuations`) —
 *     c'est la seule source fiable pour un portefeuille observé par adresse :
 *     un transfert natif (ETH, POL…) n'a pas d'adresse de contrat, donc rejouer
 *     l'historique ne permet pas de le rattacher à un jeton ;
 *  2. à défaut, les positions reconstituées depuis les activités ingérées, avec
 *     les cours du module market data.
 *
 * ⚠️ Le suivi par adresse seule ne voit que ce qui a été synchronisé : si un
 * indexer n'est pas configuré, le wallet apparaît avec un historique partiel —
 * l'avertissement correspondant est renvoyé à l'interface.
 */
export class CryptoService {
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #valuations: ValuationRepository;
  readonly #market: MarketRepository;
  readonly #connections: ConnectionRepository;

  constructor(db: Db, options: { baseCurrency: string }) {
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#valuations = new ValuationRepository(db);
    this.#market = new MarketRepository(db);
    this.#connections = new ConnectionRepository(db);
    void options.baseCurrency;
  }

  crypto(): CryptoResponse {
    const latestQuotes = this.#market.latestQuotes();
    const wallets: CryptoWalletDto[] = [];
    const warnings: string[] = [];

    for (const account of this.#accounts.list()) {
      if (account.type !== 'CRYPTO') continue;

      const declared = this.#declaredPositions(account.id, latestQuotes, warnings);
      if (declared !== null) {
        wallets.push({
          accountId: account.id,
          name: account.name,
          address: account.external_account_id ?? '—',
          chains: [...new Set(declared.assets.map((asset) => asset.chain))],
          valueEur: round(sum(declared.assets.map((asset) => asset.valueEur))),
          assets: declared.assets,
          lastSyncedAt: declared.lastSyncedAt,
        });
        continue;
      }

      const rows = this.#activities.listForAccount(account.id);
      // « Mes cryptos » (saisie manuelle) vide : rien à montrer, rien à signaler.
      if (rows.length === 0 && account.external_account_id === MANUAL_CRYPTO_ID && !account.connection_id) continue;
      if (rows.length === 0) {
        wallets.push({
          accountId: account.id,
          name: account.name,
          address: account.external_account_id ?? '—',
          chains: [],
          valueEur: 0,
          assets: [],
          lastSyncedAt: account.connection_id ? (this.#connections.get(account.connection_id)?.last_synced_at ?? null) : null,
        });
        warnings.push(
          `« ${account.name} » : aucun avoir détecté (portefeuille vide ou pas encore synchronisé).`,
        );
        continue;
      }

      const domain = rows.map((row) => toDomainActivity(row, account.currency));
      const lastPrices: Record<string, number> = {};
      for (const activity of domain) {
        if (!activity.instrumentId) continue;
        const quote = latestQuotes.get(activity.instrumentId);
        if (quote) lastPrices[activity.instrumentId] = quote.close;
      }
      const calc = computePositions({ activities: domain, lastPrices, currency: account.currency, onInconsistency: 'clamp' });

      const assets = calc.positions
        .filter((position) => position.quantity > 0)
        .map((position) => {
          const instrument = position.instrumentId ? this.#instruments.get(position.instrumentId) : null;
          return {
            instrumentId: position.instrumentId ?? null,
            chain: instrument?.chain ?? 'unknown',
            symbol: instrument?.symbol ?? '—',
            name: instrument?.name ?? position.instrumentId,
            contractAddress: instrument?.contract_address ?? null,
            quantity: position.quantity,
            price: position.lastPrice,
            currency: account.currency,
            valueEur: round(position.marketValue),
            isNative: instrument?.contract_address === null,
          };
        });

      for (const asset of assets) {
        if (asset.price === null) {
          warnings.push(
            `Prix indisponible pour ${asset.symbol} : valorisé au coût de revient (approximation signalée).`,
          );
        }
      }

      wallets.push({
        accountId: account.id,
        name: account.name,
        address: account.external_account_id ?? '—',
        chains: [...new Set(assets.map((asset) => asset.chain))],
        valueEur: round(sum(assets.map((asset) => asset.valueEur))),
        assets,
        lastSyncedAt: rows.reduce<string | null>(
          (latest, row) => (!latest || row.last_synced_at > latest ? row.last_synced_at : latest),
          null,
        ),
      });
    }

    const total = round(sum(wallets.map((wallet) => wallet.valueEur)));
    const byChainMap = new Map<string, number>();
    for (const wallet of wallets) {
      for (const asset of wallet.assets) {
        // Plateformes et saisies manuelles : pas de réseau à afficher.
        const chain = asset.chain === 'unknown' ? 'Hors blockchain' : asset.chain;
        byChainMap.set(chain, round((byChainMap.get(chain) ?? 0) + asset.valueEur));
      }
    }

    return {
      wallets: wallets.sort((a, b) => b.valueEur - a.valueEur),
      totalEur: total,
      allocation: this.#slices(
        wallets.flatMap((wallet) => wallet.assets.map((asset) => ({ key: asset.symbol, value: asset.valueEur }))),
      ),
      byChain: this.#slices([...byChainMap.entries()].map(([key, value]) => ({ key, value }))),
      warnings,
    };
  }

  /**
   * Positions déclarées par la source (dernière synchronisation).
   *
   * `null` signifie « aucune position connue » : l'appelant retombe alors sur la
   * reconstitution depuis les activités. Une position sans quantité exploitable
   * est ignorée avec un avertissement plutôt que comptée à zéro.
   */
  #declaredPositions(
    accountId: string,
    latestQuotes: Map<string, { close: number }>,
    warnings: string[],
  ): { assets: CryptoAssetDto[]; lastSyncedAt: string | null } | null {
    const positions = this.#valuations.latestPositionsForAccount(accountId);
    if (positions.length === 0) return null;

    const assets: CryptoAssetDto[] = [];
    let lastSyncedAt: string | null = null;
    for (const position of positions) {
      if (position.date > (lastSyncedAt ?? '')) lastSyncedAt = position.date;
      // Quantité nulle : actif vendu ou transféré depuis, simplement plus détenu.
      if (position.quantity === 0) continue;
      if (position.quantity === null || position.quantity < 0) {
        warnings.push(
          `Position ${position.symbol ?? position.name} ignorée : quantité inconnue (resynchronisez ce wallet).`,
        );
        continue;
      }
      const quantity = position.quantity;
      const quote = latestQuotes.get(position.instrumentId);
      const price: number | null = quote ? quote.close : position.unitPrice;
      assets.push({
        instrumentId: position.instrumentId,
        chain: position.chain ?? 'unknown',
        symbol: position.symbol ?? '—',
        name: position.name,
        contractAddress: position.contractAddress,
        quantity,
        price,
        currency: position.currency,
        // Sans cours ni prix communiqué, la valeur déclarée est conservée telle
        // quelle plutôt que remise à zéro.
        valueEur: price === null ? round(position.value) : round(quantity * price),
        isNative: position.contractAddress === null,
      });
      if (price === null) {
        warnings.push(
          `Prix indisponible pour ${position.symbol ?? position.name} : valorisé à la dernière valeur connue.`,
        );
      }
    }
    return { assets, lastSyncedAt };
  }

  #slices(items: readonly { key: string; value: number }[]): AllocationSlice[] {
    const map = new Map<string, number>();
    for (const item of items) map.set(item.key, round((map.get(item.key) ?? 0) + item.value));
    const total = sum([...map.values()].map((value) => Math.abs(value)));
    return [...map.entries()]
      .map(([key, value]) => ({
        key,
        label: key,
        value,
        percent: total > 0 ? round((Math.abs(value) / total) * 100, 2) : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }
}

export { WEALTH_CLASSES, type PeriodKey };