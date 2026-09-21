import type { Activity, ActivityType, ProviderId } from '../src/types.ts';

/**
 * Fabrique d'activités pour les tests (et les fixtures anonymisées des connecteurs).
 *
 * Signes respectés : `BUY` a un montant négatif (sortie de trésorerie), `SELL` positif.
 * `amount` est net de frais, comme dans le modèle.
 */
export interface ActivityInput {
  id?: string;
  accountId?: string;
  type: ActivityType;
  date: string;
  instrumentId?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  /** Force le montant ; sinon il est déduit du type, de la quantité et du prix. */
  amount?: number;
  currency?: string;
  fees?: number;
  taxes?: number;
  description?: string | null;
  providerId?: ProviderId;
  externalTransactionId?: string | null;
}

export function activity(input: ActivityInput): Activity {
  const quantity = input.quantity ?? null;
  const unitPrice = input.unitPrice ?? null;
  const fees = input.fees ?? 0;
  let amount = input.amount;

  if (amount === undefined) {
    const gross = (quantity ?? 0) * (unitPrice ?? 0);
    switch (input.type) {
      case 'BUY':
        amount = -(gross + fees);
        break;
      case 'SELL':
        amount = gross - fees;
        break;
      case 'TRANSFER_IN':
        amount = -(gross + fees);
        break;
      default:
        amount = gross;
        break;
    }
  }

  return {
    id: input.id ?? `act-${Math.random().toString(36).slice(2, 10)}`,
    accountId: input.accountId ?? 'acc-1',
    type: input.type,
    date: input.date,
    instrumentId: input.instrumentId ?? null,
    quantity,
    unitPrice,
    amount,
    currency: input.currency ?? 'EUR',
    fees,
    taxes: input.taxes ?? 0,
    fxRateToBase: null,
    description: input.description ?? null,
    provenance: {
      providerId: input.providerId ?? 'manual',
      externalAccountId: null,
      externalTransactionId: input.externalTransactionId ?? null,
      externalAssetId: null,
      rawSourceType: null,
      lastSyncedAt: `${input.date}T00:00:00.000Z`,
      dedupHash: `hash-${input.id ?? 'x'}-${input.date}`,
      syncRunId: null,
    },
  };
}
