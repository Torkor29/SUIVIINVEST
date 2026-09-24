import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AddAssetRequest,
  AssetSearchResponse,
  AssetSearchResultDto,
  HoldingAssetDto,
  HoldingKind,
} from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { assetBadge, HOLDING_KIND_LABELS, todayIso } from '../../lib/holdings.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Badge } from '../ui/Stat.tsx';
import { Sheet } from '../ui/Sheet.tsx';
import { OperationForm, PlanForm } from './HoldingForms.tsx';

type Step = { readonly kind: 'search' } | { readonly kind: 'manual' } | { readonly kind: 'details'; readonly asset: HoldingAssetDto; readonly warning: string | null };

/**
 * Ajouter un investissement : chercher l'actif (action, ETF, crypto…), puis
 * déclarer un achat (ou une position déjà détenue) ou programmer des achats.
 */
export function AddInvestmentSheet({
  onClose,
  onAdded,
  initialAsset,
  initialMode = 'buy',
}: {
  readonly onClose: () => void;
  readonly onAdded: () => void;
  readonly initialAsset?: HoldingAssetDto;
  readonly initialMode?: 'buy' | 'plan';
}) {
  const [step, setStep] = useState<Step>(initialAsset ? { kind: 'details', asset: initialAsset, warning: null } : { kind: 'search' });
  const navigate = useNavigate();

  const title =
    step.kind === 'details' ? step.asset.name : step.kind === 'manual' ? 'Actif sans cotation publique' : 'Ajouter un investissement';
  const subtitle =
    step.kind === 'details'
      ? [step.asset.symbol, step.asset.kindLabel, step.asset.exchange].filter(Boolean).join(' · ')
      : step.kind === 'manual'
        ? 'Obligation, fonds non coté, part de SCPI… vous indiquez vous-même le cours.'
        : 'Action, ETF, fonds, crypto : cherchez par nom, symbole ou ISIN.';

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose} testId="add-investment">
      {step.kind === 'search' && (
        <AssetSearch onPicked={(asset, warning) => setStep({ kind: 'details', asset, warning })} onManual={() => setStep({ kind: 'manual' })} />
      )}
      {step.kind === 'manual' && (
        <ManualAssetForm onCreated={(asset) => setStep({ kind: 'details', asset, warning: null })} onBack={() => setStep({ kind: 'search' })} />
      )}
      {step.kind === 'details' && (
        <AssetEntry
          asset={step.asset}
          warning={step.warning}
          initialMode={initialMode}
          onDone={() => {
            onAdded();
            onClose();
            navigate(`/investissements/${step.asset.instrumentId}`);
          }}
        />
      )}
    </Sheet>
  );
}

function AssetSearch({
  onPicked,
  onManual,
}: {
  readonly onPicked: (asset: HoldingAssetDto, warning: string | null) => void;
  readonly onManual: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AssetSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useAction();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      setError(null);
      request<AssetSearchResponse>('/api/holdings/search', { query: { q }, signal: controller.signal })
        .then(setResults)
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Recherche impossible.');
        })
        .finally(() => !controller.signal.aborted && setSearching(false));
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const pick = (item: AssetSearchResultDto): void => {
    const payload: AddAssetRequest = {
      source: item.source,
      priceSymbol: item.priceSymbol,
      symbol: item.symbol,
      name: item.name,
      kind: item.kind,
      isin: item.isin,
      exchange: item.exchange,
    };
    void add.run(async () => {
      const result = await request<{ asset: HoldingAssetDto; warning: string | null }>('/api/holdings/assets', {
        method: 'POST',
        json: payload,
      });
      onPicked(result.asset, result.warning);
      return null;
    });
  };

  return (
    <div className="form-stack">
      <input
        className="input input-lg"
        type="search"
        autoFocus
        placeholder="Nvidia, AAPL, MSCI World, IE00B5BMR087, Bitcoin…"
        value={query}
        data-testid="asset-search"
        onChange={(event) => setQuery(event.target.value)}
      />
      {add.pending && <p className="muted small">Chargement de l’historique des cours…</p>}
      <ActionFeedback state={add} />
      {error !== null && <p className="feedback feedback-error">{error}</p>}
      {results !== null && results.unavailable.length > 0 && (
        <p className="feedback feedback-warn small">
          Momentanément indisponible : {results.unavailable.join(', ')}. Réessayez dans un instant.
        </p>
      )}
      <ul className="list search-results" data-testid="asset-results">
        {searching && results === null && <li className="muted small">Recherche…</li>}
        {(results?.results ?? []).map((item) => (
          <li key={`${item.source}-${item.priceSymbol}`}>
            <button type="button" className="list-row search-result" disabled={add.pending} onClick={() => pick(item)}>
              <span className="logo" aria-hidden="true">
                {assetBadge(item.symbol, item.name)}
              </span>
              <span className="list-row-main">
                <strong>{item.name}</strong>
                <span>
                  {item.symbol}
                  {item.exchange ? ` · ${item.exchange}` : item.isin && item.isin !== item.symbol ? ` · ${item.isin}` : ''}
                </span>
              </span>
              <Badge tone={item.kind === 'CRYPTO' ? 'info' : 'neutral'}>{item.typeLabel}</Badge>
            </button>
          </li>
        ))}
        {results !== null && results.results.length === 0 && !searching && (
          <li className="muted small">Aucun résultat. Essayez le symbole (NVDA, AI.PA pour Air Liquide…) ou l’ISIN.</li>
        )}
      </ul>
      <button type="button" className="btn btn-link" onClick={onManual} data-testid="asset-manual">
        Actif introuvable ou sans cotation (obligation, fonds…) ? L’ajouter à la main
      </button>
    </div>
  );
}

function ManualAssetForm({ onCreated, onBack }: { readonly onCreated: (asset: HoldingAssetDto) => void; readonly onBack: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<HoldingKind>('BOND');
  const [currency, setCurrency] = useState('EUR');
  const [price, setPrice] = useState('');
  const save = useAction();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = Number.parseFloat(price.replace(',', '.'));
    void save.run(async () => {
      const result = await request<{ asset: HoldingAssetDto }>('/api/holdings/assets', {
        method: 'POST',
        json: {
          source: 'manual',
          name: name.trim(),
          kind,
          currency,
          ...(Number.isFinite(parsed) && parsed > 0 ? { price: parsed, priceDate: todayIso() } : {}),
        },
      });
      onCreated(result.asset);
      return null;
    });
  };
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Nom</span>
          <input className="input" required value={name} placeholder="ex. OAT 3 % 2034" onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Type</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value as HoldingKind)}>
            {(Object.keys(HOLDING_KIND_LABELS) as HoldingKind[]).map((key) => (
              <option key={key} value={key}>
                {HOLDING_KIND_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Devise</span>
          <select className="input" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {['EUR', 'USD', 'GBP', 'CHF'].map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Cours actuel</span>
          <input className="input" inputMode="decimal" value={price} placeholder="ex. 98,5" onChange={(event) => setPrice(event.target.value)} />
          <span className="field-hint">Vous pourrez le mettre à jour quand vous voulez.</span>
        </label>
      </div>
      <div className="card-actions-row">
        <button type="submit" className="btn btn-primary" disabled={save.pending}>
          Continuer
        </button>
        <button type="button" className="btn btn-link" onClick={onBack}>
          Revenir à la recherche
        </button>
      </div>
      <ActionFeedback state={save} />
    </form>
  );
}

function AssetEntry({
  asset,
  warning,
  initialMode,
  onDone,
}: {
  readonly asset: HoldingAssetDto;
  readonly warning: string | null;
  readonly initialMode: 'buy' | 'plan';
  readonly onDone: () => void;
}) {
  const [mode, setMode] = useState<'buy' | 'plan'>(initialMode);
  return (
    <div className="form-stack">
      {warning !== null && (
        <p className="feedback feedback-warn small">
          {warning} Vous pouvez quand même enregistrer un achat en indiquant le prix payé.
        </p>
      )}
      <div className="segmented segmented-wide" role="tablist" aria-label="Type d’ajout">
        <button type="button" role="tab" aria-selected={mode === 'buy'} className={mode === 'buy' ? 'segmented-btn is-active' : 'segmented-btn'} onClick={() => setMode('buy')} data-testid="mode-buy">
          Achat ponctuel
        </button>
        <button type="button" role="tab" aria-selected={mode === 'plan'} className={mode === 'plan' ? 'segmented-btn is-active' : 'segmented-btn'} onClick={() => setMode('plan')} data-testid="mode-plan">
          Investissement programmé
        </button>
      </div>
      {mode === 'buy' ? (
        <OperationForm asset={asset} type="BUY" onDone={onDone} />
      ) : (
        <PlanForm asset={asset} onDone={onDone} />
      )}
    </div>
  );
}
