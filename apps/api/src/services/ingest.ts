import {
  convert,
  type ActivityType,
  type ProviderId,
  type FxRate,
} from '@suiviinvest/core';
import type {
  NormalizedAccount,
  NormalizedBalance,
  NormalizedIncome,
  NormalizedPosition,
  NormalizedTransaction,
} from '@suiviinvest/connectors';
import type { Db } from '../db/database.ts';
import { AccountRepository, InstrumentRepository, type AccountRow } from '../repositories/accounts.ts';
import { ActivityRepository, ValuationRepository, type ActivityWriteInput } from '../repositories/activities.ts';

/**
 * Couche d'ingestion : le SEUL chemin d'écriture pour les données externes.
 *
 * Les connecteurs ne connaissent ni SQLite ni ce module : ils produisent des
 * objets normalisés, que l'on traduit ici en écritures contrôlées. Conséquences
 * directes :
 *  - un connecteur ne peut pas écrire une colonne arbitraire ni contourner la
 *    déduplication ;
 *  - la conversion de devise est centralisée (une seule règle pour tous) ;
 *  - tout est enveloppé dans une transaction : un import partiel est impossible.
 *
 * L'ingestion est idempotente (via `ActivityRepository.write`) et journalisée
 * (`IngestReport` alimente `sync_runs`).
 */

export interface IngestOptions {
  readonly providerId: ProviderId;
  readonly connectionId: string | null;
  readonly syncRunId: string | null;
  readonly importId: string | null;
  readonly baseCurrency: string;
  readonly trigger: 'MANUAL' | 'SCHEDULED' | 'IMPORT';
  readonly now?: Date;
  /**
   * Compte cible imposé : utilisé par l'assistant d'import, où c'est l'utilisateur
   * qui choisit le compte de destination. Les identifiants de compte présents dans
   * le fichier servent alors uniquement de traçabilité (`rawSourceType`/provenance).
   */
  readonly accountIdOverride?: string | null;
}

export interface IngestReport {
  /** Lignes de données (activités, revenus) réellement créées / mises à jour / ignorées. */
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
  readonly warnings: string[];
  /** Comptage distinct des comptes : ils ne sont pas des « éléments ajoutés » pour l'utilisateur. */
  readonly accountsCreated: number;
  readonly accountsUpdated: number;
  readonly accountsTouched: number;
  readonly instrumentsTouched: number;
  /** Valorisations écrites (positions et soldes de trésorerie). */
  readonly valuationsWritten: number;
}

export function emptyReport(): IngestReport {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    warnings: [],
    accountsCreated: 0,
    accountsUpdated: 0,
    accountsTouched: 0,
    instrumentsTouched: 0,
    valuationsWritten: 0,
  };
}

function mergeReports(...reports: IngestReport[]): IngestReport {
  return {
    created: reports.reduce((acc, r) => acc + r.created, 0),
    updated: reports.reduce((acc, r) => acc + r.updated, 0),
    skipped: reports.reduce((acc, r) => acc + r.skipped, 0),
    errors: reports.reduce((acc, r) => acc + r.errors, 0),
    warnings: reports.flatMap((r) => r.warnings),
    accountsCreated: reports.reduce((acc, r) => acc + r.accountsCreated, 0),
    accountsUpdated: reports.reduce((acc, r) => acc + r.accountsUpdated, 0),
    accountsTouched: Math.max(0, ...reports.map((r) => r.accountsTouched)),
    instrumentsTouched: Math.max(0, ...reports.map((r) => r.instrumentsTouched)),
    valuationsWritten: reports.reduce((acc, r) => acc + r.valuationsWritten, 0),
  };
}

export class IngestService {
  readonly #db: Db;
  readonly #accounts: AccountRepository;
  readonly #instruments: InstrumentRepository;
  readonly #activities: ActivityRepository;
  readonly #valuations: ValuationRepository;

  constructor(db: Db) {
    this.#db = db;
    this.#accounts = new AccountRepository(db);
    this.#instruments = new InstrumentRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#valuations = new ValuationRepository(db);
  }

  get accounts(): AccountRepository {
    return this.#accounts;
  }

  get instruments(): InstrumentRepository {
    return this.#instruments;
  }

  get activities(): ActivityRepository {
    return this.#activities;
  }

  /**
   * Ingère un lot complet en une transaction : comptes, positions (valorisations),
   * soldes de trésorerie (activités de dépôt/retrait ajustées), transactions et revenus.
   */
  ingestBatch(
    batch: {
      accounts?: readonly NormalizedAccount[];
      balances?: readonly NormalizedBalance[];
      positions?: readonly NormalizedPosition[];
      transactions?: readonly NormalizedTransaction[];
      income?: readonly NormalizedIncome[];
    },
    options: IngestOptions,
  ): IngestReport {
    return this.#db.transaction(() => {
      const warnings: string[] = [];
      let accountsTouched = 0;
      let accountsCreated = 0;
      let accountsUpdated = 0;
      let instrumentsTouched = 0;
      let valuationsWritten = 0;
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors = 0;

      // 1. comptes
      const accountByExternalId = new Map<string, AccountRow>();
      for (const account of batch.accounts ?? []) {
        const { account: row, created: isNew } = this.#accounts.upsertFromProvider({
          name: account.name,
          type: account.type,
          providerId: options.providerId,
          currency: account.currency,
          externalAccountId: account.externalAccountId,
          connectionId: options.connectionId,
          isActive: account.isActive ?? true,
        });
        accountByExternalId.set(account.externalAccountId, row);
        if (isNew) accountsCreated++;
        else accountsUpdated++;
        accountsTouched++;
      }

      // Les comptes déjà connus doivent être résolus même si le lot ne les
      // redécrit pas (cas d'une synchro de transactions seules).
      const overrideAccount = options.accountIdOverride
        ? this.#accounts.get(options.accountIdOverride)
        : null;
      if (options.accountIdOverride && !overrideAccount) {
        warnings.push(`Compte cible introuvable : ${options.accountIdOverride}`);
      }

      const resolveAccount = (externalAccountId: string | null): AccountRow | null => {
        if (overrideAccount) return overrideAccount;
        if (!externalAccountId) return null;
        const cached = accountByExternalId.get(externalAccountId);
        if (cached) return cached;
        const existing = this.#accounts.findByExternal(options.providerId, externalAccountId);
        if (existing) {
          accountByExternalId.set(externalAccountId, existing);
          return existing;
        }
        return null;
      };

      // 2. positions -> valorisations + (au premier import) une écriture d'entrée
      for (const position of batch.positions ?? []) {
        const account = resolveAccount(position.externalAccountId);
        if (!account) {
          warnings.push(
            `Position ignorée : compte externe inconnu ${position.externalAccountId} (${position.name})`,
          );
          continue;
        }
        const instrument = this.#instruments.upsert({
          kind: position.kind,
          name: position.name,
          currency: position.currency,
          symbol: position.symbol,
          isin: position.isin,
          chain: position.chain ?? null,
          contractAddress: position.contractAddress ?? null,
          decimals: position.decimals ?? null,
        });
        instrumentsTouched++;
        if (position.unitPrice !== null) {
          this.#valuations.upsert({
            accountId: account.id,
            instrumentId: instrument.id,
            date: isoDay(options.now),
            value: Math.round(position.unitPrice * position.quantity * 1e8) / 1e8,
            currency: position.currency,
            source: 'CONNECTOR',
            note: `Position ${position.rawSourceType}`,
          });
          valuationsWritten++;
        }
      }

      // 3. soldes de trésorerie -> activité de valorisation du cash
      for (const balance of batch.balances ?? []) {
        const account = resolveAccount(balance.externalAccountId);
        if (!account) {
          warnings.push(`Solde ignoré : compte externe inconnu ${balance.externalAccountId}`);
          continue;
        }
        // Un solde de trésorerie est stocké comme valorisation (et non comme
        // activité) : il ne doit JAMAIS être compté comme un revenu ou une
        // performance. Le cash réel reste dérivé des mouvements d'activité.
        this.#valuations.upsert({
          accountId: account.id,
          instrumentId: null,
          date: balance.date,
          value: balance.cash,
          currency: balance.currency,
          source: 'CONNECTOR',
          note: `Solde ${balance.rawSourceType}`,
        });
        valuationsWritten++;
      }

      // 4. transactions -> activités idempotentes
      const rates = this.#ratesFor(options);
      for (const transaction of batch.transactions ?? []) {
        const account = resolveAccount(transaction.externalAccountId);
        if (!account) {
          warnings.push(`Transaction ignorée : compte externe inconnu ${transaction.externalAccountId}`);
          continue;
        }
        const instrumentId = transaction.externalAssetId
          ? this.#resolveInstrumentId(transaction)
          : this.#maybeInstrumentForSecurity(transaction);
        if (instrumentId) instrumentsTouched++;

        const matched = this.#matchFx(
          transaction.amount,
          transaction.currency,
          rates,
          transaction.date,
          options.baseCurrency,
        );
        if (matched === null) {
          warnings.push(
            `Taux ${transaction.currency}->${options.baseCurrency} indisponible au ${transaction.date} : ` +
              `la ligne ${transaction.externalTransactionId ?? transaction.description} est enregistrée ` +
              'dans sa devise mais exclue des totaux convertis.',
          );
        }
        const write: ActivityWriteInput = {
          accountId: account.id,
          instrumentId,
          type: transaction.type as ActivityType,
          date: transaction.date,
          quantity: transaction.quantity,
          unitPrice: transaction.unitPrice,
          amount: transaction.amount,
          currency: transaction.currency,
          fees: transaction.fees,
          taxes: transaction.taxes,
          description: transaction.description,
          providerId: options.providerId,
          externalAccountId: transaction.externalAccountId,
          externalTransactionId: transaction.externalTransactionId,
          externalAssetId: transaction.externalAssetId,
          rawSourceType: transaction.rawSourceType,
          syncRunId: options.syncRunId,
          importId: options.importId,
          lastSyncedAt: (options.now ?? new Date()).toISOString(),
          fxRateToBase: matched?.rate ?? null,
        };
        try {
          const result = this.#activities.write(write);
          if (result.outcome === 'CREATED') created++;
          else if (result.outcome === 'UPDATED') updated++;
          else skipped++;
        } catch (error) {
          warnings.push(
            `Ligne rejetée (${transaction.externalTransactionId ?? 'sans id'}) : ` +
              `${error instanceof Error ? error.message : 'erreur inconnue'}`,
          );
        }
      }

      // 5. revenus -> activités de type DIVIDEND / INTEREST / STAKING_REWARD
      for (const income of batch.income ?? []) {
        const account = resolveAccount(income.externalAccountId);
        if (!account) {
          warnings.push(`Revenu ignoré : compte externe inconnu ${income.externalAccountId}`);
          continue;
        }
        const result = this.#activities.write({
          accountId: account.id,
          instrumentId: null,
          type: income.type,
          date: income.date,
          quantity: null,
          unitPrice: null,
          amount: income.amount,
          currency: income.currency,
          fees: 0,
          taxes: income.withholdingTax,
          description: income.description,
          providerId: options.providerId,
          externalAccountId: income.externalAccountId,
          externalTransactionId: income.externalTransactionId,
          externalAssetId: null,
          rawSourceType: income.rawSourceType,
          syncRunId: options.syncRunId,
          importId: options.importId,
          lastSyncedAt: (options.now ?? new Date()).toISOString(),
          fxRateToBase:
            this.#matchFx(income.amount, income.currency, rates, income.date, options.baseCurrency)?.rate ??
            null,
        });
        if (result.outcome === 'CREATED') created++;
        else if (result.outcome === 'UPDATED') updated++;
        else skipped++;
      }

      return {
        created,
        updated,
        skipped,
        errors,
        warnings,
        accountsCreated,
        accountsUpdated,
        accountsTouched,
        instrumentsTouched,
        valuationsWritten,
      };
    });
  }

  /** Ingestion d'un import fichier : mêmes garanties, provenance `IMPORT`. */
  ingestImport(
    batch: {
      accounts?: readonly NormalizedAccount[];
      positions?: readonly NormalizedPosition[];
      transactions?: readonly NormalizedTransaction[];
      income?: readonly NormalizedIncome[];
    },
    options: IngestOptions,
  ): IngestReport {
    return this.ingestBatch(batch, options);
  }

  #ratesFor(options: IngestOptions): FxRate[] {
    const rows = this.#db.all<{ base: string; quote: string; date: string; rate: number; source: string }>(
      'SELECT base, quote, date, rate, source FROM fx_rates ORDER BY date',
    );
    if (rows.length === 0 && options.baseCurrency !== 'EUR') return [];
    return rows.map((row) => ({
      base: row.base,
      quote: row.quote,
      date: row.date,
      rate: row.rate,
      source: row.source,
    }));
  }

  #matchFx(
    amount: number,
    currency: string,
    rates: readonly FxRate[],
    date: string,
    baseCurrency: string,
  ): { amount: number; rate: number } | null {
    // Ne devine jamais un taux : sans donnée de change, la ligne est conservée
    // dans sa devise et signalée (voir l'avertissement émis par l'appelant).
    return convert(amount, currency, baseCurrency, rates, date);
  }

  #resolveInstrumentId(transaction: NormalizedTransaction): string | null {
    const existing = this.#instruments.find({
      isin: transaction.externalAssetId && transaction.externalAssetId.length === 12
        ? transaction.externalAssetId
        : null,
      symbol: transaction.externalAssetId && transaction.externalAssetId.length !== 12
        ? transaction.externalAssetId
        : null,
    });
    if (existing) return existing.id;
    if (!transaction.externalAssetId) return null;
    const looksLikeIsin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(transaction.externalAssetId.toUpperCase());
    return this.#instruments.upsert({
      kind: looksLikeIsin ? 'EQUITY' : 'OTHER',
      name: transaction.description || (transaction.externalAssetId ?? 'Instrument inconnu'),
      currency: transaction.currency,
      isin: looksLikeIsin ? transaction.externalAssetId : null,
      symbol: looksLikeIsin ? null : transaction.externalAssetId,
    }).id;
  }

  /** Un achat/vente de titre sans identifiant d'actif crée un instrument générique par compte. */
  #maybeInstrumentForSecurity(transaction: NormalizedTransaction): string | null {
    if (transaction.type !== 'BUY' && transaction.type !== 'SELL') return null;
    if (!transaction.description) return null;
    return this.#instruments.upsert({
      kind: 'OTHER',
      name: transaction.description,
      currency: transaction.currency,
    }).id;
  }
}

export function isoDay(date: Date | undefined): string {
  return (date ?? new Date()).toISOString().slice(0, 10);
}

export { mergeReports };