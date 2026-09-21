import { round, sum } from './money.ts';
import type { Activity, CurrencyCode, Position } from './types.ts';

/**
 * Calcul des positions (holdings) et du PRU à partir du journal d'activités.
 *
 * Méthode : coût moyen pondéré (PCM), frais inclus dans le prix de revient.
 * C'est la méthode la plus courante en Europe pour un particulier (et celle que
 * retiennent les courtiers français pour l'affichage du PRU).
 *
 * Conventions :
 *  - `Activity.amount` est déjà net de frais et signé depuis le compte
 *    (achat < 0, vente > 0). Voir `types.ts`.
 *  - Une vente ne peut pas faire passer la quantité sous zéro : une vente à
 *    découvert serait un signal de données corrompues, on lève une erreur plutôt
 *    que de propager un PRU négatif dans tout le reporting.
 */

export interface PositionInput {
  readonly activities: readonly Activity[];
  readonly lastPrices?: Readonly<Record<string, number>>;
  /** Devise d'affichage ; les activités dans une autre devise doivent déjà être converties. */
  readonly currency?: CurrencyCode;
}

export interface PositionCalculation {
  readonly positions: readonly Position[];
  readonly realizedPnl: number;
  readonly dividends: number;
  readonly fees: number;
  readonly taxes: number;
  readonly interest: number;
  /** Positions sans devise d'achat identique à celle du portefeuille (signalées, pas fusionnées). */
  readonly mixedCurrencyInstruments: readonly string[];
}

interface MutableState {
  quantity: number;
  costBasis: number;
  realizedPnl: number;
  dividends: number;
  fees: number;
  taxes: number;
  interest: number;
  firstDate: string | null;
  lastDate: string | null;
  currency: CurrencyCode;
  externalFees: number;
}

const emptyState = (currency: CurrencyCode): MutableState => ({
  quantity: 0,
  costBasis: 0,
  realizedPnl: 0,
  dividends: 0,
  fees: 0,
  taxes: 0,
  interest: 0,
  firstDate: null,
  lastDate: null,
  currency,
  externalFees: 0,
});

export function computePositions(input: PositionInput): PositionCalculation {
  const currency = input.currency ?? 'EUR';
  const states = new Map<string, MutableState>();
  const mixed = new Set<string>();

  // Ordre chronologique stable : indispensable pour un PRU reproductible.
  const ordered = [...input.activities].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  for (const activity of ordered) {
    const key = activity.instrumentId ?? `__account__:${activity.accountId}`;
    const state = states.get(key) ?? emptyState(currency);
    states.set(key, state);

    if (activity.instrumentId && activity.currency !== currency) mixed.add(activity.instrumentId);
    if (!state.firstDate || activity.date < state.firstDate) state.firstDate = activity.date;
    if (!state.lastDate || activity.date > state.lastDate) state.lastDate = activity.date;

    const qty = activity.quantity ?? 0;
    const amount = activity.amount;

    switch (activity.type) {
      case 'BUY':
      case 'TRANSFER_IN': {
        // Un transfert entrant ne porte aucun flux de trésorerie : il doit fournir
        // le coût de revient transféré (montant négatif ou prix unitaire explicite).
        const cost =
          activity.type === 'BUY'
            ? -amount
            : amount !== 0
              ? -amount
              : qty * (activity.unitPrice ?? 0);
        state.costBasis = round(state.costBasis + Math.max(0, cost));
        state.quantity = round(state.quantity + qty);
        break;
      }
      case 'CRYPTO_TRANSFER': {
        // Un mouvement on-chain n'est ni un achat ni une vente : le SENS est porté
        // par le signe du montant (entrant > 0, sortant < 0). Sans cela, les tokens
        // reçus sur un wallet n'apparaîtraient jamais dans les positions.
        if (amount > 0) {
          state.quantity = round(state.quantity + qty);
          // Coût de revient = valeur au moment de la réception (pas un prix d'achat).
          state.costBasis = round(state.costBasis + amount);
        } else {
          const unitCost = averageCost(state);
          state.costBasis = round(state.costBasis - qty * unitCost);
          state.quantity = round(Math.max(0, state.quantity - qty));
          if (state.quantity <= 1e-9) {
            state.quantity = 0;
            state.costBasis = 0;
          }
        }
        break;
      }
      case 'SELL': {
        if (qty > state.quantity + 1e-9) {
          throw new Error(
            `Vente de ${qty} > position ${state.quantity} pour ${key} le ${activity.date} ` +
              '(données incohérentes : vérifier l\'ordre des imports et les splits)',
          );
        }
        const unitCost = averageCost(state);
        state.realizedPnl = round(state.realizedPnl + (amount - qty * unitCost));
        state.costBasis = round(state.costBasis - qty * unitCost);
        state.quantity = round(state.quantity - qty);
        if (state.quantity <= 1e-9) {
          state.quantity = 0;
          state.costBasis = 0;
        }
        break;
      }
      case 'TRANSFER_OUT': {
        const unitCost = averageCost(state);
        state.costBasis = round(state.costBasis - qty * unitCost);
        state.quantity = round(Math.max(0, state.quantity - qty));
        break;
      }
      case 'SPLIT': {
        // `quantity` porte le ratio du split (ex. 2 = doublement).
        const ratio = qty > 0 ? qty : 1;
        state.quantity = round(state.quantity * ratio);
        break;
      }
      case 'DIVIDEND':
        state.dividends = round(state.dividends + amount);
        break;
      case 'INTEREST':
        state.interest = round(state.interest + amount);
        break;
      case 'STAKING_REWARD': {
        // Un reward de staking est un revenu ET, s'il est versé en token, une
        // quantité supplémentaire : les deux doivent être enregistrés.
        state.interest = round(state.interest + amount);
        if (qty > 0) {
          state.quantity = round(state.quantity + qty);
          state.costBasis = round(state.costBasis + Math.max(0, amount));
        }
        break;
      }
      case 'FEE':
      case 'BANK_EXPENSE':
        state.fees = round(state.fees + Math.abs(amount));
        break;
      case 'TAX':
        state.taxes = round(state.taxes + Math.abs(amount));
        break;
      default:
        break;
    }
  }

  const positions: Position[] = [];
  for (const [key, state] of states) {
    if (!key.startsWith('__account__:') && state.quantity <= 1e-9 && state.realizedPnl === 0) {
      continue;
    }
    const instrumentId = key.startsWith('__account__:') ? '' : key;
    const lastPrice = instrumentId ? input.lastPrices?.[instrumentId] ?? null : null;
    const unitCost = averageCost(state);
    const marketValue = instrumentId
      ? round(state.quantity * (lastPrice ?? unitCost))
      : round(state.costBasis);
    positions.push({
      accountId: '',
      instrumentId,
      quantity: state.quantity,
      averageCost: unitCost,
      costBasis: round(state.costBasis),
      currency,
      lastPrice: lastPrice ?? null,
      marketValue,
      unrealizedPnl: round(marketValue - state.costBasis),
      realizedPnl: round(state.realizedPnl),
      dividends: round(state.dividends),
      fees: round(state.fees),
      firstActivityDate: state.firstDate,
    });
  }

  return {
    positions: positions.sort((a, b) => b.marketValue - a.marketValue),
    realizedPnl: round(sum(positions.map((p) => p.realizedPnl))),
    dividends: round(sum(positions.map((p) => p.dividends))),
    fees: round(sum(positions.map((p) => p.fees))),
    taxes: round(sum([...states.values()].map((s) => s.taxes))),
    interest: round(sum([...states.values()].map((s) => s.interest))),
    mixedCurrencyInstruments: [...mixed],
  };
}

function averageCost(state: MutableState): number {
  if (state.quantity <= 1e-12) return 0;
  return round(state.costBasis / state.quantity);
}

/** Agrège plusieurs calculs (multi-comptes) en un portefeuille consolidé. */
export function mergePositions(calculations: readonly PositionCalculation[]): PositionCalculation {
  const byInstrument = new Map<string, Position>();
  let realizedPnl = 0;
  let dividends = 0;
  let fees = 0;
  let taxes = 0;
  let interest = 0;
  const mixed = new Set<string>();

  for (const calc of calculations) {
    realizedPnl += calc.realizedPnl;
    dividends += calc.dividends;
    fees += calc.fees;
    taxes += calc.taxes;
    interest += calc.interest;
    for (const id of calc.mixedCurrencyInstruments) mixed.add(id);

    for (const position of calc.positions) {
      const existing = byInstrument.get(position.instrumentId);
      if (!existing) {
        byInstrument.set(position.instrumentId, { ...position });
        continue;
      }
      const quantity = round(existing.quantity + position.quantity);
      const costBasis = round(existing.costBasis + position.costBasis);
      const lastPrice = position.lastPrice ?? existing.lastPrice;
      const marketValue = round(quantity * (lastPrice ?? (quantity ? costBasis / quantity : 0)));
      byInstrument.set(position.instrumentId, {
        ...existing,
        quantity,
        costBasis,
        averageCost: quantity > 1e-12 ? round(costBasis / quantity) : 0,
        marketValue,
        unrealizedPnl: round(marketValue - costBasis),
        realizedPnl: round(existing.realizedPnl + position.realizedPnl),
        dividends: round(existing.dividends + position.dividends),
        fees: round(existing.fees + position.fees),
        lastPrice,
        firstActivityDate:
          existing.firstActivityDate && position.firstActivityDate
            ? existing.firstActivityDate < position.firstActivityDate
              ? existing.firstActivityDate
              : position.firstActivityDate
            : existing.firstActivityDate ?? position.firstActivityDate,
      });
    }
  }

  const positions = [...byInstrument.values()].sort((a, b) => b.marketValue - a.marketValue);
  return {
    positions,
    realizedPnl: round(realizedPnl),
    dividends: round(dividends),
    fees: round(fees),
    taxes: round(taxes),
    interest: round(interest),
    mixedCurrencyInstruments: [...mixed],
  };
}