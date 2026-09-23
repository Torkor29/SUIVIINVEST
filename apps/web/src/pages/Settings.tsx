import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HealthResponse, MarketDataRefreshResponse, SettingsDto } from '@suiviinvest/api-contract';
import { isMockEnabled, request, setMockEnabled } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { formatDate, formatRelative, formatUptime } from '../lib/format.ts';
import { useTheme } from '../lib/useTheme.ts';
import type { ThemeChoice } from '../lib/theme.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { SkeletonLines } from '../components/ui/Skeleton.tsx';
import { KeyValue, Badge } from '../components/ui/Stat.tsx';
import { IconCheck, IconShield } from '../components/ui/Icons.tsx';

const THEMES: readonly { readonly value: ThemeChoice; readonly label: string }[] = [
  { value: 'system', label: 'Automatique' },
  { value: 'light', label: 'Clair' },
  { value: 'dark', label: 'Sombre' },
];

/** Paramètres : apparence, cours de bourse, sauvegardes, sécurité et état du serveur. */
export function SettingsPage() {
  const theme = useTheme();
  const [mock, setMock] = useState<boolean>(() => isMockEnabled());
  const state = useAsync<SettingsDto>((signal) => request<SettingsDto>('/api/settings', { signal }), []);
  const health = useAsync<HealthResponse>((signal) => request<HealthResponse>('/health', { signal }), []);
  const refresh = useAction();
  const backup = useAction();

  const changeTheme = (choice: ThemeChoice): void => {
    theme.setChoice(choice);
    void request<SettingsDto>('/api/settings', { method: 'PATCH', json: { theme: choice } }).catch(() => undefined);
  };

  return (
    <>
      <PageHeader title="Paramètres" subtitle="Apparence, cours de bourse, sauvegardes et sécurité de votre serveur." />

      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        skeleton={<SkeletonLines lines={6} />}
      >
        {(settings) => (
          <>
            <Grid className="grid-2">
              <Card title="Apparence">
                <div className="segmented" role="group" aria-label="Thème">
                  {THEMES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={theme.choice === item.value ? 'segmented-btn is-active' : 'segmented-btn'}
                      aria-pressed={theme.choice === item.value}
                      onClick={() => changeTheme(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: 10 }}>
                  « Automatique » suit le réglage clair / sombre de votre appareil.
                </p>
                <label className="field field-inline">
                  <input
                    type="checkbox"
                    checked={mock}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setMock(enabled);
                      setMockEnabled(enabled);
                    }}
                  />
                  <span>Mode démo (données fictives, sans serveur)</span>
                </label>
                <p className="muted small">Prend effet au prochain rechargement de la page.</p>
              </Card>

              <Card title="Cours de bourse" subtitle="Les cours et taux de change sont mis à jour à chaque synchronisation.">
                <div className="chips">
                  {settings.marketDataProviders.map((provider) => (
                    <Badge key={provider} tone="neutral">
                      {provider}
                    </Badge>
                  ))}
                </div>
                <div className="card-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={refresh.pending}
                    onClick={() =>
                      void refresh.run(async () => {
                        const result = await request<MarketDataRefreshResponse>('/api/market-data/refresh', {
                          method: 'POST',
                        });
                        return result.message;
                      })
                    }
                  >
                    {refresh.pending ? 'Actualisation…' : 'Actualiser les cours'}
                  </button>
                </div>
                <ActionFeedback state={refresh} />
              </Card>

              <Card title="Sauvegardes" subtitle="Une copie complète de vos données, chaque nuit, sur votre serveur.">
                <div className="kv-grid">
                  <KeyValue label="Sauvegarde automatique" value={settings.backup.enabled ? 'Activée' : 'Désactivée'} />
                  <KeyValue
                    label="Dernière sauvegarde"
                    value={settings.backup.lastBackupAt === null ? 'Aucune' : formatRelative(settings.backup.lastBackupAt)}
                  />
                  <KeyValue label="Conservation" value={`${settings.backup.retentionDays} jours`} />
                  <KeyValue
                    label="Chiffrement"
                    value={settings.security.backupsEncrypted === true ? 'Chiffrées (AES-256)' : 'Non chiffrées'}
                    tone={settings.security.backupsEncrypted === true ? 'up' : 'down'}
                  />
                </div>
                <div className="card-actions-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={backup.pending}
                    onClick={() =>
                      void backup.run(async () => {
                        await request<unknown>('/api/backup/export', { method: 'POST' });
                        return 'Sauvegarde créée sur le serveur.';
                      })
                    }
                  >
                    {backup.pending ? 'Sauvegarde…' : 'Sauvegarder maintenant'}
                  </button>
                </div>
                <ActionFeedback state={backup} />
              </Card>

              <Card title="Sécurité" subtitle="Ce qui protège vos données sur le serveur.">
                <ul className="list" data-testid="security-list">
                  <SecurityRow label="Mots de passe" detail="Hachés (Argon2id) : illisibles, même avec la base." />
                  <SecurityRow label="E-mails" detail="Chiffrés (AES-256-GCM)." />
                  <SecurityRow label="Identifiants des banques et courtiers" detail="Chiffrés (AES-256-GCM), jamais réaffichés." />
                  <SecurityRow label="Sessions" detail={`Jetons hachés, expiration après ${settings.security.sessionTtlMinutes} min d’inactivité.`} />
                  <SecurityRow
                    label="Sauvegardes"
                    detail={settings.security.backupsEncrypted === true ? 'Chiffrées sur le disque.' : 'Non chiffrées : activez SUIVIINVEST_BACKUP_ENCRYPTION.'}
                    ok={settings.security.backupsEncrypted === true}
                  />
                  <SecurityRow
                    label="Lien « mot de passe oublié » par e-mail"
                    detail={settings.security.emailConfigured === true ? 'Envoi d’e-mails configuré.' : 'Non configuré : le code de secours reste disponible.'}
                    ok={settings.security.emailConfigured === true}
                  />
                </ul>
                <p className="muted small" style={{ marginTop: 8 }}>
                  Algorithme : {settings.security.argon2Params}. Gérez votre mot de passe et vos appareils dans{' '}
                  <Link to="/profil" className="btn-link">
                    Profil
                  </Link>
                  .
                </p>
              </Card>
            </Grid>

            <Card title="Serveur">
              {health.data === null ? (
                <SkeletonLines lines={3} />
              ) : (
                <div className="kv-grid">
                  <KeyValue
                    label="État"
                    value={health.data.status === 'ok' ? 'Opérationnel' : 'Dégradé'}
                    tone={health.data.status === 'ok' ? 'up' : 'down'}
                  />
                  <KeyValue label="Version" value={health.data.version} />
                  <KeyValue label="En ligne depuis" value={formatUptime(health.data.uptimeSeconds)} />
                  <KeyValue label="Devise de référence" value={settings.baseCurrency} />
                  <KeyValue
                    label="Synchro automatique"
                    value={settings.scheduler.enabled ? 'Activée' : 'Désactivée'}
                  />
                  <KeyValue label="Dernière synchro" value={formatDate(health.data.lastSyncAt)} />
                  <KeyValue
                    label="Base de données"
                    value={health.data.database.ok ? `OK · ${health.data.database.migrations} migrations` : 'Indisponible'}
                  />
                  <KeyValue label="Sources disponibles" value={`${health.data.connectors}`} />
                </div>
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}

function SecurityRow({ label, detail, ok = true }: { readonly label: string; readonly detail: string; readonly ok?: boolean }) {
  return (
    <li className="list-row">
      <span className={ok ? 'logo tone-up' : 'logo tone-down'} aria-hidden="true">
        {ok ? <IconCheck size={18} /> : <IconShield size={18} />}
      </span>
      <span className="list-row-main">
        <strong>{label}</strong>
        <span>{detail}</span>
      </span>
    </li>
  );
}
