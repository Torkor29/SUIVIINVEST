import { round } from './money.ts';
import type { Activity } from './types.ts';

/**
 * Mesures de performance.
 *
 * Objectif central : séparer la performance de MARCHÉ des nouveaux apports.
 * Un virement d'un de mes comptes vers un autre de mes comptes n'est ni un revenu
 * ni une performance — il est neutralisé (`classifyFlows`).
 */

export interface DatedFlow {
  readonly date: string;
  /** Signé depuis le portefeuille : dépôt/apport > 0, retrait < 0. */
  readonly amount: number;
}

export interface DailyValue {
  readonly date: string;
  readonly value: number;
}

export interface FlowClassification {
  /** Flux externes au portefeuille (apports, retraits réels). */
  readonly external: readonly DatedFlow[];
  /** Virements internes neutralisés, avec leur contrepartie. */
  readonly internal: readonly { date: string; amount: number; fromAccountId: string; toAccountId: string }[];
  /** Transferts sans contrepartie détectée : comptés comme externes, à signaler. */
  readonly unmatchedTransfers: readonly DatedFlow[];
}

const FLOW_TOLERANCE = 0.01;

/**
 * Sépare les flux internes des flux externes.
 *
 * Un TRANSFER_OUT est considéré interne si un TRANSFER_IN du même montant absolu,
 * à la même date, existe sur un AUTRE compte du périmètre analysé.
 */
export function classifyFlows(activities: readonly Activity[], periodStart?: string): FlowClassification {
  const transfersOut = activities.filter(
    (a) => a.type === 'TRANSFER_OUT' && (!periodStart || a.date >= periodStart),
  );
  const transfersIn = activities.filter(
    (a) => a.type === 'TRANSFER_IN' && (!periodStart || a.date >= periodStart),
  );
  const usedIn = new Set<string>();
  const usedOut = new Set<string>();
  const internal: { date: string; amount: number; fromAccountId: string; toAccountId: string }[] = [];

  for (const out of transfersOut) {
    const match = transfersIn.find(
      (candidate) =>
        !usedIn.has(candidate.id) &&
        candidate.date === out.date &&
        candidate.accountId !== out.accountId &&
        Math.abs(Math.abs(candidate.amount) - Math.abs(out.amount)) <= FLOW_TOLERANCE,
    );
    if (!match) continue;
    usedIn.add(match.id);
    usedOut.add(out.id);
    internal.push({
      date: out.date,
      amount: round(Math.abs(out.amount)),
      fromAccountId: out.accountId,
      toAccountId: match.accountId,
    });
  }

  const external: DatedFlow[] = [];
  const unmatched: DatedFlow[] = [];
  for (const activity of activities) {
    if (periodStart && activity.date < periodStart) continue;
    switch (activity.type) {
      case 'DEPOSIT':
        external.push({ date: activity.date, amount: round(activity.amount) });
        break;
      case 'WITHDRAWAL':
        external.push({ date: activity.date, amount: -round(Math.abs(activity.amount)) });
        break;
      case 'TRANSFER_IN':
        if (!usedIn.has(activity.id)) {
          const flow = { date: activity.date, amount: round(activity.amount) };
          unmatched.push(flow);
          external.push(flow);
        }
        break;
      case 'TRANSFER_OUT':
        if (!usedOut.has(activity.id)) {
          const flow = { date: activity.date, amount: -round(Math.abs(activity.amount)) };
          unmatched.push(flow);
          external.push(flow);
        }
        break;
      default:
        break;
    }
  }
  return { external, internal, unmatchedTransfers: unmatched };
}

/**
 * TWR (Time-Weighted Return) chaîné jour par jour.
 *
 * Convention retenue : les flux externes sont considérés comme survenant en FIN
 * de journée. Le rendement du jour est donc
 *   r = V_fin / (V_debut + flux) - 1
 * puis les rendements sont chaînés : Π(1 + r) - 1.
 *
 * Cette convention est la plus simple à expliquer et n'introduit pas de biais
 * quand les flux sont petits devant le portefeuille ; elle est documentée ici
 * pour que toute divergence avec un autre outil soit explicable.
 */
export function twr(values: readonly DailyValue[], flows: readonly DatedFlow[]): number {
  if (values.length < 2) return 0;
  const ordered = [...values].sort((a, b) => (a.date < b.date ? -1 : 1));
  const flowByDate = new Map<string, number>();
  for (const flow of flows) {
    flowByDate.set(flow.date, round((flowByDate.get(flow.date) ?? 0) + flow.amount));
  }

  let compounded = 1;
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1] as DailyValue;
    const current = ordered[i] as DailyValue;
    const flow = flowByDate.get(current.date) ?? 0;
    const base = previous.value + flow;
    if (base <= 0) continue; // compte vidé : le rendement du jour n'est pas défini
    const dailyReturn = current.value / base - 1;
    compounded *= 1 + dailyReturn;
  }
  return round((compounded - 1) * 100, 4);
}

/**
 * Modified Dietz sur une période : mesure robuste quand on ne dispose que des
 * valeurs de début/fin et des flux datés (cas des comptes sans historique quotidien).
 */
export function modifiedDietz(
  startValue: number,
  endValue: number,
  flows: readonly DatedFlow[],
  periodStart: string,
  periodEnd: string,
): number {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  const totalDays = (end - start) / 86_400_000;
  if (totalDays <= 0) return 0;

  let netFlow = 0;
  let weightedFlow = 0;
  for (const flow of flows) {
    const flowDate = Date.parse(flow.date);
    if (flowDate < start || flowDate > end) continue;
    netFlow += flow.amount;
    const weight = (end - flowDate) / 86_400_000 / totalDays;
    weightedFlow += flow.amount * weight;
  }
  const averageCapital = startValue + weightedFlow;
  if (averageCapital === 0) return 0;
  return round(((endValue - startValue - netFlow) / averageCapital) * 100, 4);
}

export interface CashFlow {
  readonly date: string;
  /** Négatif = capital investi, positif = encaissement/valorisation finale. */
  readonly amount: number;
}

/**
 * XIRR : taux de rendement interne d'une série de flux irréguliers.
 *
 * Résolution par Newton-Raphson, avec repli sur une dichotomie si la dérivée
 * devient instable (typique quand les flux sont très asymétriques). Retourne
 * `null` quand aucune solution n'existe dans (-0.9999, 1e6) : mieux vaut ne rien
 * afficher qu'un taux inventé.
 */
export function xirr(flows: readonly CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null;
  const ordered = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const start = Date.parse((ordered[0] as CashFlow).date);
  const years = ordered.map((f) => (Date.parse(f.date) - start) / 86_400_000 / 365);
  const amounts = ordered.map((f) => f.amount);

  const npv = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < amounts.length; i++) {
      total += (amounts[i] as number) / (1 + rate) ** (years[i] as number);
    }
    return total;
  };
  const dNpv = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < amounts.length; i++) {
      const y = years[i] as number;
      total -= (y * (amounts[i] as number)) / (1 + rate) ** (y + 1);
    }
    return total;
  };

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const value = npv(rate);
    if (Math.abs(value) < 1e-7) return round(rate * 100, 4);
    const derivative = dNpv(rate);
    if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
    const next = rate - value / derivative;
    if (!Number.isFinite(next)) break;
    if (next <= -0.999999) {
      rate = (rate - 0.999999) / 2;
      continue;
    }
    if (Math.abs(next - rate) < 1e-10) return round(next * 100, 4);
    rate = next;
  }

  // Repli : dichotomie sur un intervalle large.
  let low = -0.9999;
  let high = 10;
  let fLow = npv(low);
  let fHigh = npv(high);
  if (fLow * fHigh > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return round(mid * 100, 4);
    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return round(((low + high) / 2) * 100, 4);
}

/** Construit les flux XIRR d'un compte : apports négatifs, valeur finale positive. */
export function buildXirrFlows(
  flows: readonly DatedFlow[],
  finalDate: string,
  finalValue: number,
): CashFlow[] {
  const result: CashFlow[] = flows.map((f) => ({ date: f.date, amount: -f.amount }));
  result.push({ date: finalDate, amount: round(finalValue) });
  return result;
}

export function maxDrawdown(values: readonly DailyValue[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const point of values) {
    peak = Math.max(peak, point.value);
    if (peak <= 0) continue;
    worst = Math.min(worst, point.value / peak - 1);
  }
  return round(worst * 100, 4);
}

/** Rendement annualisé à partir d'un rendement cumulé et d'une durée en jours. */
export function annualize(cumulativePercent: number, days: number): number | null {
  if (days <= 0) return null;
  const growth = 1 + cumulativePercent / 100;
  if (growth <= 0) return null;
  return round((growth ** (365 / days) - 1) * 100, 4);
}