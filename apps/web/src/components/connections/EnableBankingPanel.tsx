import { useMemo, useState } from 'react';
import { request } from '../../lib/api.ts';
import { useAsync } from '../../lib/useAsync.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Card } from '../ui/Card.tsx';
import { Badge } from '../ui/Stat.tsx';

interface EnableBankingStatus {
  readonly configured: boolean;
  readonly applicationId: string | null;
  readonly redirectUrl: string;
}

interface AspspRow {
  readonly name: string;
  readonly country: string;
  readonly logo: string | null;
}

const COUNTRIES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'FR', label: 'France' },
  { code: 'BE', label: 'Belgique' },
  { code: 'LU', label: 'Luxembourg' },
  { code: 'DE', label: 'Allemagne' },
  { code: 'ES', label: 'Espagne' },
  { code: 'IT', label: 'Italie' },
  { code: 'NL', label: 'Pays-Bas' },
  { code: 'PT', label: 'Portugal' },
  { code: 'IE', label: 'Irlande' },
  { code: 'LT', label: 'Lituanie (Revolut)' },
];

/**
 * Ajout d'une banque par open banking (Enable Banking).
 *
 * Étape 1, une seule fois : l'application Enable Banking de l'utilisateur
 * (identifiant + clé privée, chiffrés sur le serveur). Étape 2, pour chaque
 * banque : choix de la banque, puis accord donné sur le site de la banque.
 */
export function EnableBankingPanel({ onChanged }: { readonly onChanged: () => void }) {
  const status = useAsync<EnableBankingStatus>(
    (signal) => request<EnableBankingStatus>('/api/enable-banking/status', { signal }),
    [],
  );

  return (
    <div className="conn-card-wrap conn-wide" data-testid="enable-banking-panel">
      <Card
        title="Ajouter une banque"
        subtitle="Accès officiel en lecture seule (open banking européen) : soldes et opérations remontent tout seuls."
        actions={
          status.data?.configured ? <Badge tone="ok">Application configurée</Badge> : <Badge tone="neutral">À configurer</Badge>
        }
      >
        {status.data === null ? (
          <p className="muted small">Chargement…</p>
        ) : status.data.configured ? (
          <BankPicker redirectUrl={status.data.redirectUrl} onChanged={onChanged} onReset={status.reload} />
        ) : (
          <AppSetup redirectUrl={status.data.redirectUrl} onSaved={status.reload} />
        )}
      </Card>
    </div>
  );
}

function RedirectHint({ redirectUrl }: { readonly redirectUrl: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice">
      <span>
        Adresse de retour à déclarer dans votre application Enable Banking :{' '}
        <code className="inline-code" data-testid="enable-banking-redirect">
          {redirectUrl}
        </code>{' '}
        <button
          type="button"
          className="btn btn-link"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(redirectUrl)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? 'Copiée ✓' : 'Copier'}
        </button>
      </span>
    </div>
  );
}

function AppSetup({ redirectUrl, onSaved }: { readonly redirectUrl: string; readonly onSaved: () => void }) {
  const [applicationId, setApplicationId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const save = useAction();

  const readFile = (file: File | undefined): void => {
    if (!file) return;
    void file.text().then(setPrivateKey);
  };

  return (
    <div className="form-stack eb-setup">
      <ol className="steps-list">
        <li>
          Créez un compte gratuit sur{' '}
          <a className="btn-link" href="https://enablebanking.com/cp/" target="_blank" rel="noreferrer">
            enablebanking.com
          </a>
          .
        </li>
        <li>
          Dans « API applications », enregistrez une application en environnement <strong>Production</strong> ; choisissez
          « Generate in the browser » pour obtenir la clé privée (fichier <code>.pem</code>).
        </li>
        <li>Déclarez l’adresse de retour ci-dessous, puis liez vos propres comptes (« Link accounts ») : l’accès est gratuit pour vos comptes.</li>
        <li>Collez ici l’identifiant de l’application et la clé privée.</li>
      </ol>
      <RedirectHint redirectUrl={redirectUrl} />
      <label className="field">
        <span className="field-label">Identifiant de l’application (Application ID)</span>
        <input
          className="input"
          data-testid="enable-banking-app-id"
          value={applicationId}
          spellCheck={false}
          autoComplete="off"
          placeholder="ex. 0b1c2d3e-…"
          onChange={(event) => setApplicationId(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Clé privée (.pem)</span>
        <textarea
          className="input textarea"
          data-testid="enable-banking-private-key"
          rows={4}
          spellCheck={false}
          placeholder="-----BEGIN PRIVATE KEY----- …"
          value={privateKey}
          onChange={(event) => setPrivateKey(event.target.value)}
        />
        <span className="field-hint">
          Ou choisissez le fichier :{' '}
          <input type="file" accept=".pem,.key,.txt" onChange={(event) => readFile(event.target.files?.[0])} />
        </span>
      </label>
      <p className="muted small">La clé est vérifiée auprès d’Enable Banking puis stockée chiffrée sur votre serveur. Elle n’est jamais réaffichée.</p>
      <div>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="enable-banking-save-app"
          disabled={save.pending || applicationId.trim() === '' || privateKey.trim() === ''}
          onClick={() =>
            void save.run(async () => {
              await request('/api/enable-banking/app', {
                method: 'PUT',
                json: { applicationId: applicationId.trim(), privateKey: privateKey.trim() },
              });
              setPrivateKey('');
              onSaved();
              return 'Application Enable Banking enregistrée.';
            })
          }
        >
          {save.pending ? 'Vérification…' : 'Enregistrer'}
        </button>
      </div>
      <ActionFeedback state={save} />
    </div>
  );
}

function BankPicker({
  redirectUrl,
  onChanged,
  onReset,
}: {
  readonly redirectUrl: string;
  readonly onChanged: () => void;
  readonly onReset: () => void;
}) {
  const [country, setCountry] = useState('FR');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [returnUrl, setReturnUrl] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const authorize = useAction();
  const complete = useAction();
  const remove = useAction();
  const banks = useAsync<{ aspsps: readonly AspspRow[] }>(
    (signal) => request<{ aspsps: readonly AspspRow[] }>('/api/enable-banking/aspsps', { query: { country }, signal }),
    [country],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = banks.data?.aspsps ?? [];
    return (needle === '' ? list : list.filter((bank) => bank.name.toLowerCase().includes(needle))).slice(0, 60);
  }, [banks.data, search]);

  return (
    <div className="form-stack eb-picker">
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Pays</span>
          <select
            className="input"
            value={country}
            onChange={(event) => {
              setCountry(event.target.value);
              setSelected(null);
            }}
          >
            {COUNTRIES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Rechercher une banque</span>
          <input
            className="input"
            data-testid="enable-banking-search"
            value={search}
            placeholder="Crédit Agricole, Revolut, Boursorama…"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {banks.error !== null ? (
        <p className="feedback feedback-error">{banks.error}</p>
      ) : (
        <ul className="bank-list" data-testid="enable-banking-banks">
          {banks.data === null && <li className="muted small">Chargement des banques…</li>}
          {filtered.map((bank) => (
            <li key={`${bank.country}-${bank.name}`}>
              <button
                type="button"
                className={selected === bank.name ? 'bank-item is-selected' : 'bank-item'}
                onClick={() => setSelected(bank.name)}
              >
                {bank.logo ? <img src={bank.logo} alt="" loading="lazy" /> : <span className="logo">{bank.name.slice(0, 2)}</span>}
                <span>{bank.name}</span>
              </button>
            </li>
          ))}
          {banks.data !== null && filtered.length === 0 && <li className="muted small">Aucune banque ne correspond.</li>}
        </ul>
      )}

      <div className="card-actions-row">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="enable-banking-authorize"
          disabled={selected === null || authorize.pending}
          onClick={() =>
            void authorize.run(async () => {
              const result = await request<{ url: string }>('/api/enable-banking/authorize', {
                method: 'POST',
                json: { aspspName: selected, country },
              });
              window.location.assign(result.url);
              return 'Redirection vers votre banque…';
            })
          }
        >
          {authorize.pending ? 'Redirection…' : selected === null ? 'Choisissez une banque' : `Autoriser l’accès à ${selected}`}
        </button>
        <button type="button" className="btn btn-link" onClick={() => setShowPaste((open) => !open)}>
          Le retour de la banque n’a pas abouti ?
        </button>
      </div>
      <ActionFeedback state={authorize} />

      {showPaste && (
        <div className="conn-form">
          <p className="muted small">
            Après avoir validé chez votre banque, si la page de retour ne s’est pas ouverte correctement, copiez l’adresse
            complète affichée dans la barre du navigateur et collez-la ici.
          </p>
          <input
            className="input"
            data-testid="enable-banking-return-url"
            value={returnUrl}
            placeholder="https://…?code=…&state=…"
            onChange={(event) => setReturnUrl(event.target.value)}
          />
          <div>
            <button
              type="button"
              className="btn"
              disabled={complete.pending || returnUrl.trim() === ''}
              onClick={() =>
                void complete.run(async () => {
                  const result = await request<{ bank: string; accounts: number }>('/api/enable-banking/complete', {
                    method: 'POST',
                    json: { returnUrl: returnUrl.trim() },
                  });
                  setReturnUrl('');
                  onChanged();
                  return `${result.bank} relié : ${result.accounts} compte(s).`;
                })
              }
            >
              Valider le retour
            </button>
          </div>
          <ActionFeedback state={complete} />
        </div>
      )}

      <details className="tech-details">
        <summary>Réglages de l’application Enable Banking</summary>
        <RedirectHint redirectUrl={redirectUrl} />
        <button
          type="button"
          className="btn btn-link tone-down"
          disabled={remove.pending}
          onClick={() =>
            void remove.run(async () => {
              await request('/api/enable-banking/app', { method: 'DELETE' });
              onReset();
              return 'Application retirée.';
            })
          }
        >
          Remplacer l’identifiant et la clé de l’application
        </button>
        <ActionFeedback state={remove} />
      </details>
    </div>
  );
}
