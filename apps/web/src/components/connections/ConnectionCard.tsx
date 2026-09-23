import { useState } from 'react';
import type { ConnectionDto, ConnectionTestResultDto, SyncOutcomeDto, SyncRunDto } from '@suiviinvest/api-contract';
import { ApiRequestError, isGatewayStatus, request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { formatEur } from '../../lib/format.ts';
import { Badge } from '../ui/Stat.tsx';
import { Card } from '../ui/Card.tsx';
import {
  describeSyncOutcome,
  hasWarnings,
  isConnected,
  lastSyncLabel,
  sourceStateOf,
  syncErrorHeadline,
  syncOutcomeLabel,
  syncOutcomeTone,
  syncRunningLabel,
  type SourceAccountSummary,
  type SourceDefinition,
} from '../../lib/connections.ts';
import { ImportInline } from './ImportInline.tsx';

export interface ConnectionCardProps {
  readonly source: SourceDefinition;
  readonly connection: ConnectionDto | null;
  readonly accounts: SourceAccountSummary;
  readonly requiredConfig: readonly string[];
  readonly onChanged: () => void;
  readonly onShowRuns: (connectionId: string) => void;
  /** Identifiant de test de la carte (plusieurs cartes par source possibles). */
  readonly testId?: string;
  /** Carte vide ouverte directement sur le formulaire (bouton « Ajouter »). */
  readonly startOpen?: boolean;
  readonly onCancelNew?: () => void;
}

/**
 * Identifiants demandés à la connexion, par source.
 *
 * `secret` = chiffré sur le serveur (AES-256-GCM), jamais réaffiché ;
 * `config` = paramètre non secret. Les noms sont ceux que lisent les connecteurs.
 */
interface CredentialField {
  readonly key: string;
  readonly label: string;
  readonly kind: 'secret' | 'config';
  readonly type?: 'text' | 'password' | 'tel' | 'textarea';
  readonly optional?: boolean;
  readonly hint?: string;
  readonly placeholder?: string;
}

const CREDENTIAL_FIELDS: Readonly<Record<string, readonly CredentialField[]>> = {
  degiro: [
    { key: 'degiro_username', label: 'Identifiant DEGIRO', kind: 'secret', type: 'text' },
    { key: 'degiro_password', label: 'Mot de passe DEGIRO', kind: 'secret', type: 'password' },
    {
      key: 'degiro_totp_secret_key',
      label: 'Clé de double authentification (facultatif)',
      kind: 'secret',
      type: 'password',
      optional: true,
      hint: 'La clé secrète TOTP de votre application d’authentification, si la double authentification est activée.',
    },
    {
      key: 'degiro_int_account',
      label: 'Numéro de compte interne (facultatif)',
      kind: 'config',
      optional: true,
      hint: 'Détecté automatiquement en général.',
    },
  ],
  trade_republic: [
    {
      key: 'trade_republic_phone',
      label: 'Numéro de téléphone',
      kind: 'secret',
      type: 'tel',
      placeholder: '+33612345678',
      hint: 'Au format international, celui de votre compte Trade Republic.',
    },
    { key: 'trade_republic_pin', label: 'Code PIN', kind: 'secret', type: 'password', placeholder: '••••' },
  ],
  bitcoin: [
    {
      key: 'addresses',
      label: 'Adresses ou clé publique étendue',
      kind: 'config',
      type: 'textarea',
      placeholder: 'zpub6r… ou bc1q…, 3…, 1… (séparées par des virgules)',
      hint: 'Ledger Live : Compte → ⋯ → Modifier le compte → Avancé → xpub. Jamais de clé privée ni de phrase de récupération.',
    },
  ],
  solana: [
    { key: 'address', label: 'Adresse publique Solana', kind: 'config', placeholder: 'Ex. 7xKXtg2CW87d…' },
  ],
  binance: [
    { key: 'binance_api_key', label: 'Clé API', kind: 'secret', type: 'text' },
    {
      key: 'binance_api_secret',
      label: 'Clé secrète',
      kind: 'secret',
      type: 'password',
      hint: 'Binance → Gestion des API → créez une clé en « Lecture seule » (ne cochez ni trading ni retrait).',
    },
  ],
  kraken: [
    { key: 'kraken_api_key', label: 'Clé API', kind: 'secret', type: 'text' },
    {
      key: 'kraken_api_secret',
      label: 'Clé privée',
      kind: 'secret',
      type: 'password',
      hint: 'Kraken → Paramètres → API : cochez uniquement « Query Funds ».',
    },
  ],
  coinbase: [
    {
      key: 'coinbase_api_key_name',
      label: 'Nom de la clé API',
      kind: 'secret',
      type: 'text',
      placeholder: 'organizations/…/apiKeys/…',
    },
    {
      key: 'coinbase_api_private_key',
      label: 'Clé privée',
      kind: 'secret',
      type: 'textarea',
      placeholder: '-----BEGIN EC PRIVATE KEY----- …',
      hint: 'Coinbase Developer Platform → clés API → permission « View » uniquement.',
    },
  ],
  bitpanda: [
    {
      key: 'bitpanda_api_key',
      label: 'Clé API',
      kind: 'secret',
      type: 'password',
      hint: 'Bitpanda → Profil → Clé API : cochez seulement « Lecture » (Balance, Transaction).',
    },
  ],
};

/** Sources dont la configuration est entièrement décrite par CREDENTIAL_FIELDS. */
const FIELDS_ONLY: ReadonlySet<string> = new Set(['bitcoin', 'solana', 'binance', 'kraken', 'coinbase', 'bitpanda', 'enable_banking']);

/** Libellés des paramètres non secrets attendus par les connecteurs. */
const CONFIG_LABELS: Readonly<Record<string, string>> = {
  address: 'Adresse publique du wallet (0x…)',
  networks: 'Chaînes suivies (séparées par des virgules)',
  region: 'Région',
  environment: 'Environnement',
  devices: 'Appareils',
  accountTypes: 'Types de comptes',
};

function configLabel(key: string): string {
  return CONFIG_LABELS[key] ?? key;
}

/**
 * Fiche d'une source de collecte.
 *
 * Affiche le VRAI état renvoyé par le serveur (jamais une supposition), la
 * dernière synchronisation en clair, les comptes et la valeur récupérée, puis
 * les actions de maintenance. Une erreur technique n'est jamais montrée brute :
 * un message compréhensible est affiché, le détail part dans un `<details>`.
 */
export function ConnectionCard({
  source,
  connection,
  accounts,
  requiredConfig,
  onChanged,
  onShowRuns,
  testId,
  startOpen = false,
  onCancelNew,
}: ConnectionCardProps) {
  const test = useAction();
  const sync = useAction();
  const remove = useAction();
  const connect = useAction();
  const [showConnect, setShowConnect] = useState(startOpen);
  const renew = useAction();
  const [showImport, setShowImport] = useState(false);
  const [label, setLabel] = useState(source.providerName);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const credentialFields = CREDENTIAL_FIELDS[source.providerId] ?? [];
  const missingCredential = credentialFields.some(
    (field) =>
      field.optional !== true &&
      ((field.kind === 'secret' ? secretValues[field.key] : config[field.key]) ?? '').trim() === '',
  );
  const [outcome, setOutcome] = useState<SyncOutcomeDto | null>(null);
  const [detached, setDetached] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResultDto | null>(null);

  const state = sourceStateOf(connection);
  const connected = isConnected(connection);
  const needsReconnect = connection !== null && (connection.needsReauth || state.key === 'AUTH_REQUIRED');
  const configKeys = FIELDS_ONLY.has(source.providerId)
    ? []
    : source.providerId === 'metamask' && !requiredConfig.includes('address')
      ? [...requiredConfig, 'address']
      : [...requiredConfig];
  const canImport = (connection?.importFormats.length ?? 0) > 0 || source.providerId === 'trade_republic';

  const runConnect = (): void => {
    const cleanConfig = Object.fromEntries(Object.entries(config).filter(([, value]) => value.trim() !== ''));
    const cleanSecrets = Object.fromEntries(Object.entries(secretValues).filter(([, value]) => value.trim() !== ''));
    void connect.run(async () => {
      if (connection === null) {
        await request<{ readonly id: string }>('/api/connections', {
          method: 'POST',
          json: {
            providerId: source.providerId,
            label: label.trim() === '' ? source.providerName : label.trim(),
            config: cleanConfig,
            secrets: cleanSecrets,
          },
        });
      } else {
        // Reconnexion : on remplace les identifiants, l'historique est conservé.
        await request<{ readonly id: string }>(`/api/connections/${connection.id}`, {
          method: 'PATCH',
          json: { config: cleanConfig, secrets: cleanSecrets },
        });
      }
      setShowConnect(false);
      // Les identifiants ne restent pas dans le navigateur une fois envoyés.
      setSecretValues({});
      onChanged();
      return connection === null
        ? `${source.providerName} connecté. Lancez une synchronisation pour récupérer vos données.`
        : `Identifiants ${source.providerName} mis à jour.`;
    });
  };

  const runTest = (): void => {
    if (connection === null) return;
    setTestResult(null);
    void test.run(async () => {
      const result = await request<ConnectionTestResultDto>(`/api/connections/${connection.id}/test`, {
        method: 'POST',
      });
      setTestResult(result);
      onChanged();
      return result.ok
        ? `${source.providerName} : connexion vérifiée.`
        : `${source.providerName} : ${result.userAction ?? result.message}`;
    });
  };

  const runSync = (): void => {
    if (connection === null) return;
    setOutcome(null);
    setDetached(false);
    const startedAt = Date.now();
    void sync.run(async () => {
      try {
        const result = await request<SyncOutcomeDto>(`/api/connections/${connection.id}/sync`, { method: 'POST' });
        setOutcome(result);
        onChanged();
        return describeSyncOutcome(result);
      } catch (cause) {
        // Lien coupé (téléphone passé dans l'application du fournisseur pour
        // valider, ou délai de la passerelle) : la synchronisation continue sur
        // le serveur, on attend son résultat au lieu d'afficher une erreur.
        if (!(cause instanceof ApiRequestError) || (cause.status !== 0 && !isGatewayStatus(cause.status))) throw cause;
        setDetached(true);
        const run = await waitForRun(connection.id, startedAt);
        setDetached(false);
        onChanged();
        if (run === null) throw cause;
        if (run.status === 'SUCCESS' || run.status === 'PARTIAL') {
          return describeSyncOutcome({
            created: run.created,
            updated: run.updated,
            skipped: run.skipped,
            errors: run.errors,
            durationMs: run.durationMs ?? 0,
            status: run.status,
          });
        }
        throw new Error(run.message ?? 'La synchronisation a échoué.');
      }
    });
  };

  const runDelete = (): void => {
    if (connection === null) return;
    void remove.run(async () => {
      await request<unknown>(`/api/connections/${connection.id}`, {
        method: 'DELETE',
      });
      setOutcome(null);
      setTestResult(null);
      onChanged();
      return `Connexion ${source.providerName} supprimée.`;
    });
  };

  return (
    <div data-testid={testId ?? `connection-card-${source.providerId}`} className="conn-card-wrap">
      <Card
        title={source.providerName}
        subtitle={
          connection === null
            ? (source.description ?? 'Aucune connexion enregistrée pour cette source.')
            : connection.label
        }
        actions={
          <span className="chips">
            <Badge tone={connected ? 'ok' : 'neutral'}>{connected ? 'Connecté' : 'Non connecté'}</Badge>
            <Badge tone={state.tone} title="État renvoyé par le serveur">
              <span data-testid="connection-state">{state.label}</span>
            </Badge>
          </span>
        }
        className="conn-card"
      >
        <div className="conn-meta">
          <span data-testid="connection-last-sync">
            Dernière synchronisation&nbsp;:{' '}
            <strong>{connection === null ? '—' : lastSyncLabel(connection.lastSyncedAt)}</strong>
          </span>
          <span data-testid="connection-accounts">
            Comptes&nbsp;: <strong>{accounts.count}</strong> · Valeur récupérée&nbsp;:{' '}
            <strong>{formatEur(accounts.valueEur, 0)}</strong>
          </span>
        </div>

        {connection !== null && (
          <div className="chips">
            {connection.capabilities.positions && <Badge tone="ok">Positions</Badge>}
            {connection.capabilities.transactions && <Badge tone="ok">Transactions</Badge>}
            {connection.capabilities.balances && <Badge tone="ok">Soldes</Badge>}
            {connection.capabilities.api ? (
              <Badge tone="info">API lecture seule</Badge>
            ) : (
              <Badge tone="neutral">Import de relevés</Badge>
            )}
          </div>
        )}

        {connection?.lastError !== null && connection?.lastError !== undefined && (
          <p className="feedback feedback-error" role="alert" data-testid="connection-error">
            {syncErrorHeadline(null, connection.lastError)}
          </p>
        )}

        {state.key === 'AUTH_REQUIRED' && (
          <p className="feedback feedback-warn" data-testid="connection-auth-required">
            Validation {source.providerName} requise : cliquez sur « Synchroniser », puis acceptez aussitôt la demande
            qui arrive dans l’application {source.providerName} (vous avez environ 1 minute).
          </p>
        )}

        {sync.pending && (
          <p className="feedback feedback-ok" data-testid="connection-sync-progress">
            {detached
              ? 'La page a perdu le lien avec le serveur (normal si vous étiez dans l’application du fournisseur) : la synchronisation continue, résultat dans un instant…'
              : syncRunningLabel(source.providerName)}
          </p>
        )}
        <ActionFeedback state={sync} />

        {outcome !== null && (
          <div data-testid="connection-sync-outcome">
            <p className="feedback feedback-ok">
              <Badge tone={syncOutcomeTone(outcome.status)}>{syncOutcomeLabel(outcome.status)}</Badge>{' '}
              {outcome.message ?? describeSyncOutcome(outcome)}
            </p>
            {outcome.status !== 'SUCCESS' && outcome.errorCode !== null && (
              <p className="feedback feedback-error" role="alert">
                {syncErrorHeadline(outcome.errorCode, outcome.message)}
              </p>
            )}
            {hasWarnings(outcome) && (
              <ul className="warnings" data-testid="connection-sync-warnings">
                {outcome.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <details className="tech-details">
              <summary>Détail technique de la synchronisation</summary>
              <pre>
                {JSON.stringify(
                  {
                    syncRunId: outcome.syncRunId,
                    connectionId: outcome.connectionId,
                    providerId: outcome.providerId,
                    status: outcome.status,
                    errorCode: outcome.errorCode,
                    created: outcome.created,
                    updated: outcome.updated,
                    skipped: outcome.skipped,
                    errors: outcome.errors,
                    durationMs: outcome.durationMs,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        )}

        <ActionFeedback state={test} />
        {testResult !== null && (
          <p className={testResult.ok ? 'feedback feedback-ok' : 'feedback feedback-error'} role="status">
            {testResult.userAction ?? testResult.message}
          </p>
        )}
        <ActionFeedback state={remove} />
        <ActionFeedback state={connect} />
        <ActionFeedback state={renew} />

        {showConnect && (
          <div className="conn-form" data-testid="connection-connect-form">
            {connection === null && (
              <label className="field">
                <span className="field-label">Nom de la connexion</span>
                <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} />
              </label>
            )}
            {(connection === null ? configKeys : []).map((key) => (
              <label className="field" key={key}>
                <span className="field-label">{configLabel(key)}</span>
                <input
                  className="input"
                  data-testid={`connection-config-${key}`}
                  value={config[key] ?? ''}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
            {credentialFields.map((field) => (
              <label className="field" key={field.key}>
                <span className="field-label">{field.label}</span>
                {field.type === 'textarea' ? (
                  <textarea
                    className="input textarea"
                    data-testid={`connection-credential-${field.key}`}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={field.placeholder}
                    value={(field.kind === 'secret' ? secretValues[field.key] : config[field.key]) ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (field.kind === 'secret') setSecretValues((current) => ({ ...current, [field.key]: value }));
                      else setConfig((current) => ({ ...current, [field.key]: value }));
                    }}
                  />
                ) : (
                  <input
                    className="input"
                    data-testid={`connection-credential-${field.key}`}
                    type={field.type ?? 'text'}
                    autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                    spellCheck={false}
                    placeholder={field.placeholder}
                    value={(field.kind === 'secret' ? secretValues[field.key] : config[field.key]) ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (field.kind === 'secret') setSecretValues((current) => ({ ...current, [field.key]: value }));
                      else setConfig((current) => ({ ...current, [field.key]: value }));
                    }}
                  />
                )}
                {field.hint !== undefined && <span className="field-hint">{field.hint}</span>}
              </label>
            ))}
            {credentialFields.some((field) => field.kind === 'secret') && (
              <p className="muted small">
                Vos identifiants sont chiffrés sur votre serveur et ne sont jamais réaffichés. Accès en lecture seule :
                aucun ordre ni virement n’est possible.
              </p>
            )}
            {connection === null && source.importOnly === true && (
              <p className="muted small">
                {source.providerName} ne propose pas d’accès automatique pour les particuliers : la connexion sert à
                rattacher vos imports de relevés.
              </p>
            )}
            <div className="card-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                data-testid="connection-connect-submit"
                disabled={connect.pending || missingCredential}
                onClick={runConnect}
              >
                {connect.pending ? 'Enregistrement…' : 'Enregistrer la connexion'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setShowConnect(false);
                  onCancelNew?.();
                }}
              >
                Annuler
              </button>
            </div>
          </div>
        )}

        {showImport && (
          <ImportInline
            providerId={source.providerId}
            connectionId={connection?.id ?? null}
            onDone={() => {
              setShowImport(false);
              onChanged();
            }}
          />
        )}

        <div className="card-actions-row">
          {connection === null ? (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="connection-connect"
              onClick={() => setShowConnect((current) => !current)}
            >
              Connecter
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="connection-sync"
              disabled={sync.pending}
              onClick={runSync}
            >
              {sync.pending ? 'Synchronisation…' : 'Synchroniser'}
            </button>
          )}
          {canImport && (
            <button
              type="button"
              className="btn"
              data-testid="connection-import"
              onClick={() => setShowImport((current) => !current)}
            >
              Importer un fichier
            </button>
          )}
        </div>
        {connection !== null && (
          <div className="conn-links">
            {source.providerId === 'enable_banking' && (
              <button
                type="button"
                className="btn btn-link"
                data-testid="connection-renew"
                disabled={renew.pending}
                onClick={() =>
                  void renew.run(async () => {
                    const result = await request<{ url: string }>('/api/enable-banking/authorize', {
                      method: 'POST',
                      json: {
                        aspspName: connection.config.aspsp_name ?? connection.label,
                        country: connection.config.aspsp_country ?? 'FR',
                        connectionId: connection.id,
                      },
                    });
                    window.location.assign(result.url);
                    return 'Redirection vers votre banque…';
                  })
                }
              >
                {renew.pending ? 'Redirection…' : 'Renouveler l’autorisation'}
              </button>
            )}
            {source.providerId !== 'enable_banking' && (needsReconnect || credentialFields.length > 0) && (
              <button
                type="button"
                className="btn btn-link"
                data-testid="connection-reconnect"
                onClick={() => setShowConnect((current) => !current)}
              >
                {needsReconnect ? 'Reconnecter' : 'Modifier les identifiants'}
              </button>
            )}
            <button type="button" className="btn btn-link" onClick={runTest} disabled={test.pending}>
              {test.pending ? 'Test…' : 'Tester'}
            </button>
            <button type="button" className="btn btn-link" onClick={() => onShowRuns(connection.id)}>
              Historique
            </button>
            <button
              type="button"
              className="btn btn-link tone-down"
              data-testid="connection-disconnect"
              disabled={remove.pending}
              onClick={runDelete}
            >
              {remove.pending ? 'Suppression…' : 'Supprimer'}
            </button>
          </div>
        )}

        <details className="tech-details">
          <summary>Détail technique de la connexion</summary>
          <pre>
            {JSON.stringify(
              {
                providerId: source.providerId,
                connectionId: connection?.id ?? null,
                status: connection?.status ?? null,
                requiresUserAction: connection?.requiresUserAction ?? false,
                needsReauth: connection?.needsReauth ?? false,
                config: connection?.config ?? {},
              },
              null,
              2,
            )}
          </pre>
        </details>
      </Card>
    </div>
  );
}

/**
 * Attend la fin d'une synchronisation lancée à `startedAt` (le serveur la
 * poursuit même si la page a perdu la réponse). `null` si rien n'apparaît.
 */
async function waitForRun(connectionId: string, startedAt: number): Promise<SyncRunDto | null> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    try {
      const runs = await request<readonly SyncRunDto[]>(`/api/connections/${connectionId}/runs`);
      const run = runs.find((item) => Date.parse(item.startedAt) >= startedAt - 10_000 && item.finishedAt !== null);
      if (run) return run;
    } catch {
      // Serveur encore injoignable (réseau du téléphone qui revient) : on réessaie.
    }
  }
  return null;
}
