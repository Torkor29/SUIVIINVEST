import { useState, type FormEvent } from 'react';
import type {
  DcaPlanDto,
  DcaPlanRequest,
  HoldingAssetDto,
  HoldingOperationDto,
  HoldingOperationRequest,
} from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { formatQuantity } from '../../lib/format.ts';
import { FREQUENCY_LABELS, PLAN_CURRENCIES, todayIso } from '../../lib/holdings.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';

function currencyChoices(asset: HoldingAssetDto): string[] {
  const set = new Set<string>(['EUR', ...PLAN_CURRENCIES]);
  if (asset.quoteCurrency) set.add(asset.quoteCurrency);
  return [...set];
}

function toNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Achat ou vente ponctuel. La quantité OU le montant suffit ; sans prix, le
 * cours de clôture du jour choisi est utilisé. Pour une position déjà détenue,
 * on indique sa date d'achat et son prix de revient.
 */
export function OperationForm({
  asset,
  type,
  onDone,
  maxQuantity,
}: {
  readonly asset: HoldingAssetDto;
  readonly type: 'BUY' | 'SELL';
  readonly onDone: (operation: HoldingOperationDto) => void;
  readonly maxQuantity?: number;
}) {
  const [date, setDate] = useState(todayIso());
  const [mode, setMode] = useState<'quantity' | 'amount'>(type === 'SELL' ? 'quantity' : 'quantity');
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [fees, setFees] = useState('');
  const save = useAction();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const payload: HoldingOperationRequest = {
      instrumentId: asset.instrumentId,
      type,
      date,
      currency,
      ...(mode === 'quantity' ? { quantity: toNumber(quantity) } : { amount: toNumber(amount) }),
      ...(toNumber(price) !== undefined ? { unitPrice: toNumber(price) } : {}),
      ...(toNumber(fees) !== undefined ? { fees: toNumber(fees) } : {}),
    };
    void save.run(async () => {
      const operation = await request<HoldingOperationDto>('/api/holdings/operations', { method: 'POST', json: payload });
      onDone(operation);
      return `${type === 'BUY' ? 'Achat' : 'Vente'} enregistré : ${formatQuantity(operation.quantity)} ${asset.symbol ?? ''}`.trim();
    });
  };

  const verb = type === 'BUY' ? 'Acheté' : 'Vendu';
  return (
    <form className="form-stack" onSubmit={submit} data-testid={`operation-form-${type.toLowerCase()}`}>
      <div className="segmented" role="group" aria-label="Saisie par">
        <button type="button" className={mode === 'quantity' ? 'segmented-btn is-active' : 'segmented-btn'} onClick={() => setMode('quantity')}>
          Quantité
        </button>
        <button type="button" className={mode === 'amount' ? 'segmented-btn is-active' : 'segmented-btn'} onClick={() => setMode('amount')}>
          Montant
        </button>
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Date</span>
          <input className="input" type="date" required max={todayIso()} value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        {mode === 'quantity' ? (
          <label className="field">
            <span className="field-label">{verb} (quantité)</span>
            <input
              className="input"
              inputMode="decimal"
              required
              placeholder="ex. 10 ou 0,015"
              value={quantity}
              data-testid="operation-quantity"
              onChange={(event) => setQuantity(event.target.value)}
            />
            {maxQuantity !== undefined && <span className="field-hint">Détenu : {formatQuantity(maxQuantity)}</span>}
          </label>
        ) : (
          <label className="field">
            <span className="field-label">Montant {type === 'BUY' ? 'investi' : 'reçu'} (hors frais)</span>
            <input
              className="input"
              inputMode="decimal"
              required
              placeholder="ex. 200"
              value={amount}
              data-testid="operation-amount"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">Prix par titre (facultatif)</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="Cours de clôture du jour"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <span className="field-hint">Vous détenez déjà ce titre ? Mettez votre prix de revient (PRU).</span>
        </label>
        <label className="field">
          <span className="field-label">Devise</span>
          <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {currencyChoices(asset).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Frais (facultatif)</span>
          <input className="input" inputMode="decimal" placeholder="0" value={fees} onChange={(event) => setFees(event.target.value)} />
        </label>
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={save.pending} data-testid="operation-submit">
          {save.pending ? 'Enregistrement…' : type === 'BUY' ? 'Enregistrer l’achat' : 'Enregistrer la vente'}
        </button>
      </div>
      <ActionFeedback state={save} />
    </form>
  );
}

/** Investissement programmé : création ou modification. */
export function PlanForm({
  asset,
  plan,
  onDone,
}: {
  readonly asset: HoldingAssetDto;
  readonly plan?: DcaPlanDto;
  readonly onDone: (plan: DcaPlanDto) => void;
}) {
  const [amount, setAmount] = useState(plan ? String(plan.amount) : '');
  const [currency, setCurrency] = useState(plan?.currency ?? (asset.quoteCurrency && asset.quoteCurrency !== 'EUR' ? asset.quoteCurrency : 'EUR'));
  const [frequency, setFrequency] = useState<DcaPlanDto['frequency']>(plan?.frequency ?? 'MONTHLY');
  const [day, setDay] = useState(String(plan?.dayOfMonth ?? Number(todayIso().slice(8, 10))));
  const [startDate, setStartDate] = useState(plan?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(plan?.endDate ?? '');
  const [fees, setFees] = useState(plan && plan.fees > 0 ? String(plan.fees) : '');
  const save = useAction();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const payload: DcaPlanRequest = {
      instrumentId: asset.instrumentId,
      amount: toNumber(amount) ?? 0,
      currency,
      frequency,
      dayOfMonth: Math.min(31, Math.max(1, Number.parseInt(day, 10) || 1)),
      startDate,
      endDate: endDate === '' ? null : endDate,
      ...(toNumber(fees) !== undefined ? { fees: toNumber(fees) } : {}),
    };
    void save.run(async () => {
      const saved = plan
        ? await request<DcaPlanDto>(`/api/holdings/plans/${plan.id}`, { method: 'PATCH', json: payload })
        : await request<DcaPlanDto>('/api/holdings/plans', { method: 'POST', json: payload });
      onDone(saved);
      if (plan) return 'Investissement programmé mis à jour.';
      return saved.executions > 0
        ? `Programmé. ${saved.executions} échéance(s) passée(s) déjà calculée(s) au cours du jour.`
        : 'Programmé : les achats s’ajouteront automatiquement à chaque échéance.';
    });
  };

  return (
    <form className="form-stack" onSubmit={submit} data-testid="plan-form">
      <p className="muted small">
        Chaque échéance devient un achat au cours de clôture du jour (ou du jour de bourse suivant), en fractions de titre.
        Une date de début passée rattrape tout l’historique.
      </p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Montant par échéance</span>
          <input
            className="input"
            inputMode="decimal"
            required
            placeholder="ex. 200"
            value={amount}
            data-testid="plan-amount"
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Devise</span>
          <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {currencyChoices(asset).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Fréquence</span>
          <select className="input" value={frequency} onChange={(event) => setFrequency(event.target.value as DcaPlanDto['frequency'])}>
            {(Object.keys(FREQUENCY_LABELS) as DcaPlanDto['frequency'][]).map((key) => (
              <option key={key} value={key}>
                {FREQUENCY_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        {frequency !== 'WEEKLY' && (
          <label className="field">
            <span className="field-label">Jour du mois</span>
            <input className="input" type="number" min={1} max={31} required value={day} data-testid="plan-day" onChange={(event) => setDay(event.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="field-label">À partir du</span>
          <input className="input" type="date" required value={startDate} data-testid="plan-start" onChange={(event) => setStartDate(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Jusqu’au (facultatif)</span>
          <input className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Frais par achat (facultatif)</span>
          <input className="input" inputMode="decimal" placeholder="0" value={fees} onChange={(event) => setFees(event.target.value)} />
        </label>
      </div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={save.pending} data-testid="plan-submit">
          {save.pending ? 'Calcul…' : plan ? 'Enregistrer' : 'Programmer'}
        </button>
      </div>
      <ActionFeedback state={save} />
    </form>
  );
}

/** Cours saisi à la main (obligation, fonds non coté…). */
export function ManualPriceForm({ asset, onDone }: { readonly asset: HoldingAssetDto; readonly onDone: () => void }) {
  const [date, setDate] = useState(todayIso());
  const [price, setPrice] = useState('');
  const save = useAction();
  return (
    <form
      className="form-inline"
      onSubmit={(event) => {
        event.preventDefault();
        void save.run(async () => {
          await request(`/api/holdings/assets/${asset.instrumentId}/price`, {
            method: 'POST',
            json: { date, price: toNumber(price) ?? 0, currency: asset.quoteCurrency ?? 'EUR' },
          });
          setPrice('');
          onDone();
          return 'Cours enregistré.';
        });
      }}
    >
      <label className="field">
        <span className="field-label">Date</span>
        <input className="input" type="date" max={todayIso()} value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Cours ({asset.quoteCurrency ?? 'EUR'})</span>
        <input className="input" inputMode="decimal" required value={price} placeholder="ex. 101,2" onChange={(event) => setPrice(event.target.value)} />
      </label>
      <button type="submit" className="btn" disabled={save.pending}>
        Mettre à jour
      </button>
      <ActionFeedback state={save} />
    </form>
  );
}
