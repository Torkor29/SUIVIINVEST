import type { Account, AccountType, AssetKind, Instrument, ProviderId } from '@suiviinvest/core';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';

/**
 * Dépôts : comptes et instruments.
 *
 * Les dépôts ne contiennent AUCUNE règle métier : ils traduisent des lignes SQL
 * en objets du domaine et inversement. Les décisions (déduplication, calculs)
 * vivent dans `services/`.
 */

export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  provider_id: string;
  connection_id: string | null;
  currency: string;
  initial_balance: number;
  is_active: number;
  external_account_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertAccountInput {
  readonly name: string;
  readonly type: AccountType;
  readonly providerId: ProviderId;
  readonly currency: string;
  readonly initialBalance?: number;
  readonly externalAccountId?: string | null;
  readonly connectionId?: string | null;
  readonly notes?: string | null;
  readonly isActive?: boolean;
}

export interface UpsertCounts {
  readonly created: number;
  readonly updated: number;
}

export class AccountRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(includeInactive = true): AccountRow[] {
    const sql = includeInactive
      ? 'SELECT * FROM accounts ORDER BY type, name'
      : 'SELECT * FROM accounts WHERE is_active = 1 ORDER BY type, name';
    return this.#db.all<AccountRow>(sql);
  }

  get(id: string): AccountRow | null {
    return this.#db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
  }

  findByExternal(providerId: string, externalAccountId: string): AccountRow | null {
    return this.#db.get<AccountRow>(
      'SELECT * FROM accounts WHERE provider_id = ? AND external_account_id = ?',
      providerId,
      externalAccountId,
    );
  }

  /**
   * Insère ou met à jour un compte provenant d'un connecteur.
   *
   * L'identité d'un compte externe est `(provider_id, external_account_id)` :
   * c'est ce qui rend une synchronisation relançable sans créer de doublons.
   */
  upsertFromProvider(input: UpsertAccountInput): { account: AccountRow; created: boolean } {
    const now = new Date().toISOString();
    if (input.externalAccountId) {
      const existing = this.findByExternal(input.providerId, input.externalAccountId);
      if (existing) {
        this.#db.run(
          `UPDATE accounts SET name = ?, type = ?, currency = ?, connection_id = ?, is_active = 1,
             updated_at = ? WHERE id = ?`,
          input.name,
          input.type,
          input.currency,
          input.connectionId ?? existing.connection_id,
          now,
          existing.id,
        );
        return { account: this.get(existing.id) as AccountRow, created: false };
      }
    }
    const id = randomUUID();
    this.#db.run(
      `INSERT INTO accounts (id, name, type, provider_id, connection_id, currency, initial_balance,
         is_active, external_account_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      id,
      input.name,
      input.type,
      input.providerId,
      input.connectionId ?? null,
      input.currency,
      input.initialBalance ?? 0,
      input.externalAccountId ?? null,
      input.notes ?? null,
      now,
      now,
    );
    return { account: this.get(id) as AccountRow, created: true };
  }

  create(input: UpsertAccountInput): AccountRow {
    return this.upsertFromProvider(input).account;
  }

  update(
    id: string,
    patch: Partial<Pick<UpsertAccountInput, 'name' | 'type' | 'currency' | 'notes' | 'isActive'>>,
  ): AccountRow | null {
    const current = this.get(id);
    if (!current) return null;
    this.#db.run(
      `UPDATE accounts SET name = ?, type = ?, currency = ?, notes = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
      patch.name ?? current.name,
      patch.type ?? current.type,
      patch.currency ?? current.currency,
      patch.notes === undefined ? current.notes : patch.notes,
      patch.isActive === undefined ? current.is_active : patch.isActive ? 1 : 0,
      new Date().toISOString(),
      id,
    );
    return this.get(id);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    // Les activités sont supprimées en cascade (contrainte de clé étrangère).
    this.#db.run('DELETE FROM accounts WHERE id = ?', id);
    return true;
  }

  /** Comptes d'un connecteur donné (pour la synchronisation). */
  listByConnection(connectionId: string): AccountRow[] {
    return this.#db.all<AccountRow>('SELECT * FROM accounts WHERE connection_id = ?', connectionId);
  }

  count(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts')?.count ?? 0;
  }
}

export interface InstrumentRow {
  id: string;
  kind: AssetKind;
  symbol: string | null;
  isin: string | null;
  name: string;
  currency: string;
  exchange: string | null;
  chain: string | null;
  contract_address: string | null;
  decimals: number | null;
  country: string | null;
  /** Source du cours (« yahoo », « coingecko », « manual ») — portefeuille saisi à la main. */
  price_source?: string | null;
  price_symbol?: string | null;
  quote_currency?: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertInstrumentInput {
  readonly kind: AssetKind;
  readonly name: string;
  readonly currency: string;
  readonly symbol?: string | null;
  readonly isin?: string | null;
  readonly exchange?: string | null;
  readonly chain?: string | null;
  readonly contractAddress?: string | null;
  readonly decimals?: number | null;
  readonly country?: string | null;
}

/**
 * Instruments.
 *
 * Priorité d'identification, dans l'ordre : ISIN, puis (chaîne + adresse de
 * contrat) pour l'on-chain, puis symbole. L'ISIN est la clé de référence du
 * module market data, comme exigé.
 */
export class InstrumentRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(id: string): InstrumentRow | null {
    return this.#db.get<InstrumentRow>('SELECT * FROM instruments WHERE id = ?', id);
  }

  findByIsin(isin: string): InstrumentRow | null {
    return this.#db.get<InstrumentRow>('SELECT * FROM instruments WHERE isin = ?', isin);
  }

  findByContract(chain: string, contractAddress: string): InstrumentRow | null {
    return this.#db.get<InstrumentRow>(
      'SELECT * FROM instruments WHERE chain = ? AND contract_address = ?',
      chain,
      contractAddress.toLowerCase(),
    );
  }

  findBySymbol(symbol: string): InstrumentRow | null {
    return this.#db.get<InstrumentRow>(
      'SELECT * FROM instruments WHERE symbol = ? ORDER BY id LIMIT 1',
      symbol.toUpperCase(),
    );
  }

  find(input: { isin?: string | null; chain?: string | null; contractAddress?: string | null; symbol?: string | null }): InstrumentRow | null {
    if (input.isin) {
      const byIsin = this.findByIsin(input.isin.toUpperCase());
      if (byIsin) return byIsin;
    }
    if (input.chain && input.contractAddress) {
      const byContract = this.findByContract(input.chain, input.contractAddress);
      if (byContract) return byContract;
    }
    if (input.symbol) {
      const bySymbol = this.findBySymbol(input.symbol);
      if (bySymbol) return bySymbol;
    }
    return null;
  }

  upsert(input: UpsertInstrumentInput): InstrumentRow {
    const existing = this.find({
      isin: input.isin ?? null,
      chain: input.chain ?? null,
      contractAddress: input.contractAddress ?? null,
      symbol: input.symbol ?? null,
    });
    const now = new Date().toISOString();

    if (existing) {
      // On complète les champs manquants (un import peut enrichir un instrument
      // créé plus tôt par un autre connecteur) sans écraser une valeur connue.
      this.#db.run(
        `UPDATE instruments SET
           symbol = COALESCE(instruments.symbol, ?), isin = COALESCE(instruments.isin, ?),
           name = CASE WHEN instruments.name = '' THEN ? ELSE instruments.name END,
           exchange = COALESCE(instruments.exchange, ?), chain = COALESCE(instruments.chain, ?),
           contract_address = COALESCE(instruments.contract_address, ?),
           decimals = COALESCE(instruments.decimals, ?), country = COALESCE(instruments.country, ?),
           updated_at = ?
         WHERE id = ?`,
        input.symbol ?? null,
        input.isin?.toUpperCase() ?? null,
        input.name,
        input.exchange ?? null,
        input.chain ?? null,
        input.contractAddress?.toLowerCase() ?? null,
        input.decimals ?? null,
        input.country ?? null,
        now,
        existing.id,
      );
      return this.get(existing.id) as InstrumentRow;
    }

    const id = randomUUID();
    this.#db.run(
      `INSERT INTO instruments (id, kind, symbol, isin, name, currency, exchange, chain,
         contract_address, decimals, country, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      input.symbol ? input.symbol.toUpperCase() : null,
      input.isin ? input.isin.toUpperCase() : null,
      input.name,
      input.currency,
      input.exchange ?? null,
      input.chain ?? null,
      input.contractAddress?.toLowerCase() ?? null,
      input.decimals ?? null,
      input.country ?? null,
      now,
      now,
    );
    return this.get(id) as InstrumentRow;
  }

  list(filter?: { kind?: AssetKind; withoutQuotes?: boolean }): InstrumentRow[] {
    if (filter?.withoutQuotes) {
      return this.#db.all<InstrumentRow>(
        `SELECT i.* FROM instruments i
          WHERE i.kind NOT IN ('CASH','REAL_ESTATE')
            AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.instrument_id = i.id AND q.date >= date('now','-7 day'))
          ORDER BY i.name`,
      );
    }
    if (filter?.kind) {
      return this.#db.all<InstrumentRow>('SELECT * FROM instruments WHERE kind = ? ORDER BY name', filter.kind);
    }
    return this.#db.all<InstrumentRow>('SELECT * FROM instruments ORDER BY name');
  }

  count(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM instruments')?.count ?? 0;
  }
}

export function toDomainAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    providerId: row.provider_id as ProviderId,
    currency: row.currency,
    initialBalance: row.initial_balance,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    externalAccountId: row.external_account_id,
  };
}

export function toDomainInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    kind: row.kind,
    symbol: row.symbol,
    isin: row.isin,
    name: row.name,
    currency: row.currency,
    exchange: row.exchange,
    chain: row.chain,
    contractAddress: row.contract_address,
    decimals: row.decimals,
  };
}