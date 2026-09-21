import type { FxRate, Quote } from '@suiviinvest/core';
import type { Db } from '../db/database.ts';

/**
 * Marché : cours et taux de change.
 *
 * Le stockage est volontairement neutre vis-à-vis du fournisseur (colonne
 * `provider`) : plusieurs sources peuvent coexister et se remplacer mutuellement
 * sans migration ni perte d'historique. C'est ce qui permet d'avoir un système
 * de prix avec repli sans lier le modèle métier à Yahoo Finance ou à un autre.
 */

export class MarketRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Insère ou remplace les cours d'un instrument (idempotent par construction). */
  upsertQuotes(quotes: readonly Quote[]): number {
    if (quotes.length === 0) return 0;
    return this.#db.transaction(() => {
      let written = 0;
      for (const quote of quotes) {
        this.#db.run(
          `INSERT INTO quotes (instrument_id, date, close, currency, provider, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(instrument_id, date) DO UPDATE SET
             close = excluded.close, currency = excluded.currency,
             provider = excluded.provider, fetched_at = excluded.fetched_at`,
          quote.instrumentId,
          quote.date,
          quote.close,
          quote.currency,
          quote.provider,
          quote.fetchedAt,
        );
        written++;
      }
      return written;
    });
  }

  /** Dernier cours connu pour un instrument, à une date ou avant. */
  latestQuote(instrumentId: string, date?: string): Quote | null {
    const row = date
      ? this.#db.get<{
          instrument_id: string;
          date: string;
          close: number;
          currency: string;
          provider: string;
          fetched_at: string;
        }>(
          `SELECT * FROM quotes WHERE instrument_id = ? AND date <= ? ORDER BY date DESC LIMIT 1`,
          instrumentId,
          date,
        )
      : this.#db.get<{
          instrument_id: string;
          date: string;
          close: number;
          currency: string;
          provider: string;
          fetched_at: string;
        }>('SELECT * FROM quotes WHERE instrument_id = ? ORDER BY date DESC LIMIT 1', instrumentId);
    return row
      ? {
          instrumentId: row.instrument_id,
          date: row.date,
          close: row.close,
          currency: row.currency,
          provider: row.provider,
          fetchedAt: row.fetched_at,
        }
      : null;
  }

  /**
   * Tous les cours nécessaires à une série historique, groupés par instrument.
   * Une seule requête : le calcul de patrimoine ne fait pas N+1 requêtes.
   */
  quotesSince(from: string): Map<string, { date: string; close: number; currency: string }[]> {
    const rows = this.#db.all<{ instrument_id: string; date: string; close: number; currency: string }>(
      'SELECT instrument_id, date, close, currency FROM quotes WHERE date >= ? ORDER BY instrument_id, date',
      from,
    );
    const grouped = new Map<string, { date: string; close: number; currency: string }[]>();
    for (const row of rows) {
      const list = grouped.get(row.instrument_id) ?? [];
      list.push({ date: row.date, close: row.close, currency: row.currency });
      grouped.set(row.instrument_id, list);
    }
    return grouped;
  }

  /** Dernier cours de chaque instrument (une entrée par instrument). */
  latestQuotes(): Map<string, { date: string; close: number; currency: string }> {
    const rows = this.#db.all<{ instrument_id: string; date: string; close: number; currency: string }>(
      `SELECT q.instrument_id, q.date, q.close, q.currency FROM quotes q
        JOIN (SELECT instrument_id, MAX(date) AS max_date FROM quotes GROUP BY instrument_id) latest
          ON latest.instrument_id = q.instrument_id AND latest.max_date = q.date`,
    );
    return new Map(rows.map((row) => [row.instrument_id, { date: row.date, close: row.close, currency: row.currency }]));
  }

  quoteCount(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM quotes')?.count ?? 0;
  }

  /* ------------------------------------------------------------ taux de change */

  upsertFxRates(rates: readonly FxRate[]): number {
    if (rates.length === 0) return 0;
    return this.#db.transaction(() => {
      for (const rate of rates) {
        this.#db.run(
          `INSERT INTO fx_rates (base, quote, date, rate, source) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(base, quote, date, source) DO UPDATE SET rate = excluded.rate`,
          rate.base,
          rate.quote,
          rate.date,
          rate.rate,
          rate.source,
        );
      }
      return rates.length;
    });
  }

  /** Taux connus pour une paire, triés : base de `findRate()` du domaine. */
  ratesFor(from: string, to: string, since?: string): FxRate[] {
    const rows = this.#db.all<{ base: string; quote: string; date: string; rate: number; source: string }>(
      `SELECT base, quote, date, rate, source FROM fx_rates
        WHERE ((base = ? AND quote = ?) OR (base = ? AND quote = ?)) ${since ? 'AND date >= ?' : ''}
        ORDER BY date`,
      ...(since ? [from, to, to, from, since] : [from, to, to, from]),
    );
    return rows.map((row) => ({
      base: row.base,
      quote: row.quote,
      date: row.date,
      rate: row.rate,
      source: row.source,
    }));
  }

  /** Tous les taux utiles à une conversion vers la devise de base. */
  allRatesTo(baseCurrency: string, since?: string): FxRate[] {
    const rows = this.#db.all<{ base: string; quote: string; date: string; rate: number; source: string }>(
      `SELECT base, quote, date, rate, source FROM fx_rates
        WHERE (quote = ? OR base = ?) ${since ? 'AND date >= ?' : ''} ORDER BY date`,
      ...(since ? [baseCurrency, baseCurrency, since] : [baseCurrency, baseCurrency]),
    );
    return rows.map((row) => ({
      base: row.base,
      quote: row.quote,
      date: row.date,
      rate: row.rate,
      source: row.source,
    }));
  }

  fxRateCount(): number {
    return this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM fx_rates')?.count ?? 0;
  }
}