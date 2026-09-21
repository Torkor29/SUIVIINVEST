import type { CurrencyCode, FxRate, Money } from './types.ts';

/**
 * Arithmétique monétaire.
 *
 * Choix d'implémentation : `number` (double IEEE-754) avec arrondi systématique
 * aux frontières de calcul, plutôt qu'une librairie décimale externe. Conséquences
 * assumées :
 *  - les additions/soustractions de montants déjà arrondis à 4 décimales sont exactes
 *    dans la plage d'un patrimoine personnel (< 2^53 / 10^4 ≈ 9e11) ;
 *  - les divisions (PRU, taux, rendements) sont arrondies au plus tôt via `round()`.
 * Toute valeur persistée ou renvoyée par l'API passe par `round()`, de sorte que
 * les sérialisations sont stables et comparables.
 */

/** Décimales conservées pour les montants (couvre les crypto à 8 décimales). */
export const MONEY_SCALE = 8;

/** Décimales affichées/stockées pour les valeurs de portefeuille en devise fiat. */
export const FIAT_SCALE = 2;

export function round(value: number, decimals = MONEY_SCALE): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  // `Math.round` sur valeur décalée : évite les artefacts de type 0.1+0.2.
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}

export function money(amount: number, currency: CurrencyCode): Money {
  return { amount: round(amount), currency };
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: round(a.amount + b.amount), currency: a.currency };
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: round(a.amount - b.amount), currency: a.currency };
}

export function multiply(m: Money, factor: number): Money {
  return { amount: round(m.amount * factor), currency: m.currency };
}

export function sum(amounts: readonly number[]): number {
  // Sommation de Kahan : limite la perte de précision sur de longues séries
  // (historique de transactions, séries de valorisation).
  let total = 0;
  let compensation = 0;
  for (const value of amounts) {
    const y = value - compensation;
    const t = total + y;
    compensation = t - total - y;
    total = t;
  }
  return round(total);
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Devises incompatibles : ${a.currency} vs ${b.currency}`);
  }
}

/** Cherche le taux `from` -> `to` à une date, avec les pivots EUR et l'identité. */
export function findRate(
  rates: readonly FxRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  date: string,
  onDate: 'exact' | 'latest-on-or-before' = 'latest-on-or-before',
): FxRate | null {
  if (from === to) return { base: from, quote: to, date, rate: 1, source: 'identity' };

  const candidates = rates.filter(
    (r) => (r.base === from && r.quote === to) || (r.base === to && r.quote === from),
  );
  if (candidates.length === 0) return null;

  const eligible = onDate === 'exact'
    ? candidates.filter((r) => r.date === date)
    : candidates.filter((r) => r.date <= date);
  if (eligible.length === 0) return null;

  const best = eligible.reduce((acc, r) => (r.date > acc.date ? r : acc));
  return best.base === from ? best : invertRate(best);
}

export function invertRate(rate: FxRate): FxRate {
  if (rate.rate === 0) throw new Error('Taux de change nul, inversion impossible');
  return {
    base: rate.quote,
    quote: rate.base,
    date: rate.date,
    rate: round(1 / rate.rate, 12),
    source: `${rate.source}:inverted`,
  };
}

/**
 * Convertit un montant vers la devise de base.
 *
 * Retourne `null` si aucun taux n'est disponible : on ne devine JAMAIS un taux.
 * L'appelant décide alors d'exclure la ligne du total (et de le signaler) plutôt
 * que de fausser silencieusement le patrimoine.
 */
export function convert(
  amount: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rates: readonly FxRate[],
  date: string,
): { amount: number; rate: number } | null {
  const rate = findRate(rates, from, to, date);
  if (!rate) return null;
  return { amount: round(amount * rate.rate), rate: rate.rate };
}

/** Pourcentage de variation, robuste aux bases nulles ou négatives. */
export function variation(initial: number, final: number): { absolute: number; percent: number } {
  const absolute = round(final - initial);
  if (initial === 0) return { absolute, percent: 0 };
  return { absolute, percent: round(((final - initial) / Math.abs(initial)) * 100, 4) };
}