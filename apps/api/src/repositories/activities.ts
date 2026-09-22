import { fingerprint, type Activity, type ActivityType, type ProviderId } from '@suiviinvest/core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';

/**
 * Dépôt des activités : le cœur transactionnel du système.
 *
 * Toute écriture passe par `write()`, qui implémente l'idempotence au niveau
 * métier *et* s'appuie sur les index uniques de la base comme filet de sécurité :
 *
 *  1. identifiant externe `(provider_id, external_account_id, external_transaction_id)`
 *     -> mise à jour si des champs ont changé, sinon ignoré ;
 *  2. repli sur l'empreinte déterministe (`dedup_hash`) quand le fournisseur
 *     n'expose pas d'identifiant stable (export CSV, transfert on-chain).
 *
 * Résultat : rejouer un import ou une synchronisation ne crée jamais de doublon,
 * et les corrections apportées côté fournisseur (montant, frais) sont reprises.
 */

export type WriteOutcome = 'CREATED' | 'UPDATED' | 'SKIPPED';

export interface ActivityWriteInput {
  readonly accountId: string;
  readonly instrumentId: string | null;
  readonly type: ActivityType;
  readonly date: string;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly amount: number;
  readonly currency: string;
  readonly fees: number;
  readonly taxes: number;
  readonly description: string | null;
  readonly providerId: ProviderId;
  readonly externalAccountId: string | null;
  readonly externalTransactionId: string | null;
  readonly externalAssetId: string | null;
  readonly rawSourceType: string | null;
  readonly syncRunId: string | null;
  readonly importId: string | null;
  readonly lastSyncedAt: string;
  readonly fxRateToBase?: number | null;
}

export interface ActivityRow {
  id: string;
  account_id: string;
  instrument_id: string | null;
  type: ActivityType;
  date: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  currency: string;
  fees: number;
  taxes: number;
  fx_rate_to_base: number | null;
  description: string | null;
  provider_id: string;
  external_account_id: string | null;
  external_transaction_id: string | null;
  external_asset_id: string | null;
  raw_source_type: string | null;
  last_synced_at: string;
  dedup_hash: string;
  sync_run_id: string | null;
  import_id: string | null;
}

export interface ActivityQuery {
  readonly from?: string;
  readonly to?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly type?: string;
  readonly currency?: string;
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly search?: string;
  readonly instrumentId?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ActivityPage {
  readonly rows: ActivityRow[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly totalsByType: { type: string; amount: number; count: number }[];
}

const MAX_LIMIT = 500;

export class ActivityRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Écrit une activité de façon idempotente.
   *
   * `db.transaction()` enveloppe l'appelant (import/sync) : cette méthode ne
   * gère pas la transaction, elle est appelée N fois dans la même.
   */
  write(input: ActivityWriteInput): { outcome: WriteOutcome; id: string; dedupHash: string } {
    const dedupHash = fingerprint({
      providerId: input.providerId,
      accountId: input.accountId,
      type: input.type,
      date: input.date,
      instrumentId: input.instrumentId,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
    });

    const existing = input.externalTransactionId
      ? this.#findByExternalId(input)
      : this.#findByHash(dedupHash);

    if (existing) {
      const changed =
        existing.amount !== input.amount ||
        existing.quantity !== input.quantity ||
        existing.unit_price !== input.unitPrice ||
        existing.fees !== input.fees ||
        existing.taxes !== input.taxes ||
        (existing.description ?? '') !== (input.description ?? '') ||
        existing.date !== input.date ||
        existing.type !== input.type;
      if (!changed) {
        // Rien à faire : on rafraîchit seulement la date de dernière synchro.
        this.#db.run(
          'UPDATE activities SET last_synced_at = ? WHERE id = ?',
          input.lastSyncedAt,
          existing.id,
        );
        return { outcome: 'SKIPPED', id: existing.id, dedupHash: existing.dedup_hash };
      }
      this.#db.run(
        `UPDATE activities SET instrument_id = ?, type = ?, date = ?, quantity = ?, unit_price = ?,
           amount = ?, currency = ?, fees = ?, taxes = ?, fx_rate_to_base = ?, description = ?,
           raw_source_type = ?, last_synced_at = ?, sync_run_id = COALESCE(?, sync_run_id),
           updated_at = ? WHERE id = ?`,
        input.instrumentId,
        input.type,
        input.date,
        input.quantity,
        input.unitPrice,
        input.amount,
        input.currency,
        input.fees,
        input.taxes,
        input.fxRateToBase ?? null,
        input.description,
        input.rawSourceType,
        input.lastSyncedAt,
        input.syncRunId,
        new Date().toISOString(),
        existing.id,
      );
      return { outcome: 'UPDATED', id: existing.id, dedupHash: existing.dedup_hash };
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.run(
      `INSERT INTO activities (id, account_id, instrument_id, type, date, quantity, unit_price, amount,
         currency, fees, taxes, fx_rate_to_base, description, provider_id, external_account_id,
         external_transaction_id, external_asset_id, raw_source_type, last_synced_at, dedup_hash,
         sync_run_id, import_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.accountId,
      input.instrumentId,
      input.type,
      input.date,
      input.quantity,
      input.unitPrice,
      input.amount,
      input.currency,
      input.fees,
      input.taxes,
      input.fxRateToBase ?? null,
      input.description,
      input.providerId,
      input.externalAccountId,
      input.externalTransactionId,
      input.externalAssetId,
      input.rawSourceType,
      input.lastSyncedAt,
      dedupHash,
      input.syncRunId,
      input.importId,
      now,
      now,
    );
    return { outcome: 'CREATED', id, dedupHash };
  }

  #findByExternalId(input: ActivityWriteInput): ActivityRow | null {
    return this.#db.get<ActivityRow>(
      `SELECT * FROM activities WHERE provider_id = ? AND external_account_id IS ?
         AND external_transaction_id = ?`,
      input.providerId,
      input.externalAccountId,
      input.externalTransactionId,
    );
  }

  #findByHash(hash: string): ActivityRow | null {
    return this.#db.get<ActivityRow>('SELECT * FROM activities WHERE dedup_hash = ?', hash);
  }

  byId(id: string): ActivityRow | null {
    return this.#db.get<ActivityRow>('SELECT * FROM activities WHERE id = ?', id);
  }

  /** Toutes les activités d'un compte, triées : base des calculs de positions. */
  listForAccount(accountId: string, limit = 20_000): ActivityRow[] {
    return this.#db.all<ActivityRow>(
      'SELECT * FROM activities WHERE account_id = ? ORDER BY date, id LIMIT ?',
      accountId,
      limit,
    );
  }

  listAll(limit = 100_000): ActivityRow[] {
    return this.#db.all<ActivityRow>('SELECT * FROM activities ORDER BY date, id LIMIT ?', limit);
  }

  count(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM activities')?.count ?? 0;
  }

  countByImport(importId: string): number {
    return (
      this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM activities WHERE import_id = ?', importId)
        ?.count ?? 0
    );
  }

  /** Somme des flux par type sur une période (vue Income / Analytics). */
  sumByType(query: ActivityQuery): { type: string; amount: number; count: number }[] {
    const { where, params } = this.#buildWhere(query);
    return this.#db.all<{ type: string; amount: number; count: number }>(
      `SELECT type, ROUND(COALESCE(SUM(amount), 0), 8) AS amount, COUNT(*) AS count
         FROM activities ${where} GROUP BY type ORDER BY amount DESC`,
      ...params,
    );
  }

  /** Timeline paginée. Le curseur est `date|id`, ce qui reste stable en cas d'ajout. */
  search(query: ActivityQuery): ActivityPage {
    const { where, params } = this.#buildWhere(query, 'a');
    // Les agrégats ci-dessous interrogent la table sans alias : on reconstruit
    // la clause pour éviter « no such column: a.provider_id ».
    const totalsWhere = this.#buildWhere(query);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_LIMIT);

    const cursorClause = query.cursor ? ' AND (a.date, a.id) < (?, ?)' : '';
    const [cursorDate, cursorId] = query.cursor ? query.cursor.split('|') : [null, null];
    const cursorParams = cursorDate && cursorId ? [cursorDate, cursorId] : [];

    const rows = this.#db.all<ActivityRow>(
      `SELECT a.* FROM activities a ${where}${cursorClause}
       ORDER BY a.date DESC, a.id DESC LIMIT ?`,
      ...params,
      ...cursorParams,
      limit + 1,
    );

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];

    const totals = this.#db.all<{ type: string; amount: number; count: number }>(
      `SELECT type, ROUND(COALESCE(SUM(amount), 0), 8) AS amount, COUNT(*) AS count
         FROM activities ${totalsWhere.where} GROUP BY type ORDER BY ABS(SUM(amount)) DESC`,
      ...totalsWhere.params,
    );
    const totalRow = this.#db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM activities ${totalsWhere.where}`,
      ...totalsWhere.params,
    );

    return {
      rows: slice,
      nextCursor: hasMore && last ? `${last.date}|${last.id}` : null,
      total: totalRow?.count ?? slice.length,
      totalsByType: totals,
    };
  }

  listByType(type: ActivityType, from?: string, to?: string): ActivityRow[] {
    const clauses = ['type = ?'];
    const params: (string | number)[] = [type];
    if (from) {
      clauses.push('date >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('date <= ?');
      params.push(to);
    }
    return this.#db.all<ActivityRow>(
      `SELECT * FROM activities WHERE ${clauses.join(' AND ')} ORDER BY date DESC`,
      ...params,
    );
  }

  /**
   * Solde de trésorerie d'un compte à une date : solde initial + somme des flux.
   * C'est la seule source du cash (aucune colonne dénormalisée à maintenir).
   */
  cashBalance(accountId: string, asOf?: string): number {
    const account = this.#db.get<{ initial_balance: number }>(
      'SELECT initial_balance FROM accounts WHERE id = ?',
      accountId,
    );
    const row = this.#db.get<{ total: number | null }>(
      `SELECT SUM(amount) AS total FROM activities WHERE account_id = ? ${asOf ? 'AND date <= ?' : ''}`,
      ...(asOf ? [accountId, asOf] : [accountId]),
    );
    return (account?.initial_balance ?? 0) + (row?.total ?? 0);
  }

  /** Dates d'activité extrêmes : borne des séries historiques. */
  dateRange(): { first: string | null; last: string | null } {
    const row = this.#db.get<{ first: string | null; last: string | null }>(
      'SELECT MIN(date) AS first, MAX(date) AS last FROM activities',
    );
    return { first: row?.first ?? null, last: row?.last ?? null };
  }

  #buildWhere(query: ActivityQuery, alias = ''): { where: string; params: (string | number)[] } {
    const a = alias === '' ? '' : `${alias}.`;
    const clauses: string[] = ['1 = 1'];
    const params: (string | number)[] = [];
    if (query.from) {
      clauses.push(`${a}date >= ?`);
      params.push(query.from);
    }
    if (query.to) {
      clauses.push(`${a}date <= ?`);
      params.push(query.to);
    }
    if (query.providerId) {
      clauses.push(`${a}provider_id = ?`);
      params.push(query.providerId);
    }
    if (query.accountId) {
      clauses.push(`${a}account_id = ?`);
      params.push(query.accountId);
    }
    if (query.instrumentId) {
      clauses.push(`${a}instrument_id = ?`);
      params.push(query.instrumentId);
    }
    if (query.type) {
      clauses.push(`${a}type = ?`);
      params.push(query.type);
    }
    if (query.currency) {
      clauses.push(`${a}currency = ?`);
      params.push(query.currency);
    }
    if (query.minAmount !== undefined) {
      clauses.push(`${a}amount >= ?`);
      params.push(query.minAmount);
    }
    if (query.maxAmount !== undefined) {
      clauses.push(`${a}amount <= ?`);
      params.push(query.maxAmount);
    }
    if (query.search) {
      clauses.push(`(${a}description LIKE ? OR ${a}external_transaction_id LIKE ?)`);
      params.push(`%${query.search}%`, `%${query.search}%`);
    }
    return { where: ` WHERE ${clauses.join(' AND ')}`, params };
  }
}

export interface ValuationInput {
  readonly accountId: string;
  readonly instrumentId: string | null;
  readonly date: string;
  readonly value: number;
  readonly currency: string;
  readonly source: 'MARKET' | 'MANUAL' | 'APPRAISAL' | 'CONNECTOR';
  readonly note?: string | null;
  /** Quantité détenue, quand la source la communique (positions crypto/titres). */
  readonly quantity?: number | null;
  /** Prix unitaire communiqué par la source, quand elle le connaît. */
  readonly unitPrice?: number | null;
}

/** Position connue d'un compte, telle que la source l'a communiquée. */
export interface PositionValuationRow {
  readonly instrumentId: string;
  readonly symbol: string | null;
  readonly name: string;
  readonly kind: string;
  readonly chain: string | null;
  readonly contractAddress: string | null;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly value: number;
  readonly currency: string;
  readonly date: string;
  readonly source: string;
}

export class ValuationRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Une seule valeur par (compte, instrument, date) : la dernière écriture gagne. */
  upsert(input: ValuationInput): void {
    this.#db.run(
      `INSERT INTO valuations
         (id, account_id, instrument_id, date, value, currency, source, note, created_at, quantity, unit_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, COALESCE(instrument_id,''), date) DO UPDATE SET
         value = excluded.value, currency = excluded.currency, source = excluded.source,
         note = excluded.note, created_at = excluded.created_at,
         quantity = excluded.quantity, unit_price = excluded.unit_price`,
      randomUUID(),
      input.accountId,
      input.instrumentId,
      input.date,
      input.value,
      input.currency,
      input.source,
      input.note ?? null,
      new Date().toISOString(),
      input.quantity ?? null,
      input.unitPrice ?? null,
    );
  }

  /**
   * Dernière position connue par instrument d'un compte (positions ≠ soldes de
   * trésorerie) : c'est la source de vérité pour un portefeuille observé par
   * adresse, dont l'historique de transactions ne suffit pas à reconstituer.
   */
  latestPositionsForAccount(accountId: string): PositionValuationRow[] {
    return this.#db.all<PositionValuationRow>(
      `SELECT v.instrument_id AS instrumentId, i.symbol, i.name, i.kind,
              i.chain, i.contract_address AS contractAddress,
              v.quantity, v.unit_price AS unitPrice, v.value, v.currency, v.date, v.source
         FROM valuations v
         JOIN instruments i ON i.id = v.instrument_id
        WHERE v.account_id = ?
          AND v.instrument_id IS NOT NULL
          AND v.date = (
            SELECT MAX(v2.date) FROM valuations v2
             WHERE v2.account_id = v.account_id AND v2.instrument_id = v.instrument_id
          )
        ORDER BY v.value DESC`,
      accountId,
    );
  }

  latestForAccount(accountId: string): { date: string; value: number; currency: string } | null {
    const row = this.#db.get<{ date: string; value: number; currency: string }>(
      `SELECT date, value, currency FROM valuations WHERE account_id = ? AND instrument_id IS NULL
         ORDER BY date DESC LIMIT 1`,
      accountId,
    );
    return row ?? null;
  }

  listForAccount(accountId: string): {
    date: string;
    value: number;
    currency: string;
    source: string;
    note: string | null;
  }[] {
    return this.#db.all(
      `SELECT date, value, currency, source, note FROM valuations
        WHERE account_id = ? AND instrument_id IS NULL ORDER BY date`,
      accountId,
    );
  }

  /** Historique de valorisation d'un compte par jour (dernière valeur connue). */
  historyForAccount(accountId: string): { date: string; value: number }[] {
    return this.#db.all<{ date: string; value: number }>(
      `SELECT date, value FROM valuations WHERE account_id = ? AND instrument_id IS NULL ORDER BY date`,
      accountId,
    );
  }

  delete(id: string): void {
    this.#db.run('DELETE FROM valuations WHERE id = ?', id);
  }
}

/** Conversion d'une ligne SQL en objet du domaine (utile aux tests et exports). */
export function toDomainActivity(row: ActivityRow, accountCurrency?: string): Activity {
  return {
    id: row.id,
    accountId: row.account_id,
    type: row.type,
    date: row.date,
    instrumentId: row.instrument_id,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    amount: row.amount,
    currency: accountCurrency ?? row.currency,
    fees: row.fees,
    taxes: row.taxes,
    fxRateToBase: row.fx_rate_to_base,
    description: row.description,
    provenance: {
      providerId: row.provider_id as ProviderId,
      externalAccountId: row.external_account_id,
      externalTransactionId: row.external_transaction_id,
      externalAssetId: row.external_asset_id,
      rawSourceType: row.raw_source_type,
      lastSyncedAt: row.last_synced_at,
      dedupHash: row.dedup_hash,
      syncRunId: row.sync_run_id,
    },
  };
}