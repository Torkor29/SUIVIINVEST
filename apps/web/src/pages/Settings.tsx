import { useState } from 'react';
import type { HealthResponse, MarketDataRefreshResponse, SettingsDto } from '@suiviinvest/api-contract';
import { isMockEnabled, request, setMockEnabled } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { formatDate, formatUptime } from '../lib/format.ts';
import { useTheme } from '../lib/useTheme.ts';
import type { ThemeChoice } from '../lib/theme.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { SkeletonLines } from '../components/ui/Skeleton.tsx';
import { StatTile, KeyValue, Badge } from '../components/ui/Stat.tsx';
import { ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';

/** Paramètres : thème, données de marché, sauvegardes, sécurité et santé du serveur. */
export function SettingsPage() {
  const theme = useTheme();
  const [mock, setMock] = useState<boolean>(() => isMockEnabled());
  const state = useAsync<SettingsDto>((signal) => request<SettingsDto>('/api/settings', { signal }), []);
  const health = useAsync<HealthResponse>((signal) => request<HealthResponse>('/health', { signal }), []);
  const refresh = useAction();
  const backup = useAction();

  const changeTheme = (choice: ThemeChoice): void => {
    theme.setChoice(choice);
    void request<SettingsDto>('/api/settings', { method: 'PATCH', json: { theme: choice } })
      .then(() => state.reload())
      .catch(() => undefined);
  };

  return (
    <>
      <PageHeader title="Paramètres" subtitle="Réglages de l’application, données de marché et sauvegardes." />

      <AsyncView loading={state.loading} error={state.error} data={state.data} onRetry={state.reload} skeleton={<SkeletonLines lines={6} />}>
        {(settings) => (
          <>
            <Grid>
              <StatTile label="Version" value={settings.version} hint={`Base ${settings.databasePath}`} />
              <StatTile label="Devise de référence" value={settings.baseCurrency} hint="Toutes les contre-valeurs sont converties dans cette devise" />
              <StatTile label="Session" value={`${settings.security.sessionTtlMinutes} min`} hint={settings.security.argon2Params} />
              <StatTile label="Planificateur" value={settings.scheduler.enabled ? 'Actif' : 'Inactif'} hint={settings.scheduler.cron} />
            </Grid>

            <Grid className="grid-2">
              <Card title="Apparence" subtitle="Le thème est mémorisé et appliqué immédiatement.">
                <label className="field">
                  <span className="field-label">Thème</span>
                  <select className="input" value={theme.choice} onChange={(event) => changeTheme(event.target.value as ThemeChoice)}>
                    <option value="system">Système</option>
                    <option value="light">Clair</option>
                    <option value="dark">Sombre</option>
                  </select>
                </label>
                <p className="muted small">Paramètre enregistré côté serveur : {settings.theme}.</p>
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
                  <span>Mode maquette (données de démonstration locales, sans API)</span>
                </label>
                <p className="muted small">Le changement prend effet au prochain chargement de page (drapeau runtime, sans reconstruction).</p>
              </Card>

              <Card title="Données de marché" subtitle="Cotisations et taux de change.">
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
                        const result = await request<MarketDataRefreshResponse>('/api/market-data/refresh', { method: 'POST' });
                        return result.message;
                      })
                    }
                  >
                    {refresh.pending ? 'Actualisation…' : 'Actualiser les cotations'}
                  </button>
                </div>
                <ActionFeedback state={refresh} />
              </Card>

              <Card title="Sauvegardes" subtitle="Export de la base et rétention.">
                <div className="kv-grid">
                  <KeyValue label="Sauvegarde automatique" value={settings.backup.enabled ? 'Active' : 'Désactivée'} />
                  <KeyValue label="Planification" value={settings.backup.cron ?? '—'} />
                  <KeyValue label="Dernière sauvegarde" value={formatDate(settings.backup.lastBackupAt)} />
                  <KeyValue label="Rétention" value={`${settings.backup.retentionDays} jours`} />
                  <KeyValue label="Répertoire" value={settings.backup.directory} />
                </div>
                <div className="card-actions-row">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={backup.pending}
                    onClick={() =>
                      void backup.run(async () => {
                        await request<unknown>('/api/backup/export', { method: 'POST' });
                        return 'Export de sauvegarde déclenché.';
                      })
                    }
                  >
                    {backup.pending ? 'Export…' : 'Exporter la base'}
                  </button>
                </div>
                <ActionFeedback state={backup} />
              </Card>

              <Card title="Sécurité" subtitle="Ce qui protège vos données."
              >
                <div className="kv-grid">
                  <KeyValue label="Chiffrement" value={settings.security.encryption} />
                  <KeyValue label="Dérivation de mot de passe" value={settings.security.argon2Params} />
                  <KeyValue label="Durée de session" value={`${settings.security.sessionTtlMinutes} minutes`} />
                </div>
                <p className="muted small">Les secrets des connecteurs ne sortent jamais du serveur ; le frontend ne les affiche pas.</p>
              </Card>
            </Grid>

            <Card title="Santé du serveur" subtitle="Point de contrôle /health.">
              {health.data === null ? (
                <SkeletonLines lines={3} />
              ) : (
                <div className="kv-grid">
                  <KeyValue label="État" value={health.data.status === 'ok' ? 'Opérationnel' : 'Dégradé'} tone={health.data.status === 'ok' ? 'up' : 'down'} />
                  <KeyValue label="Version" value={health.data.version} />
                  <KeyValue label="Disponibilité" value={formatUptime(health.data.uptimeSeconds)} />
                  <KeyValue label="Base" value={health.data.database.ok ? `OK (${health.data.database.migrations} migrations)` : 'Indisponible'} />
                  <KeyValue label="Connecteurs" value={`${health.data.connectors}`} />
                  <KeyValue label="Dernière synchro" value={formatDate(health.data.lastSyncAt)} />
                </div>
              )}
            </Card>

            <ReadOnlyNote text="Mode lecture seule : aucune fonction d’achat, de vente, de virement ou de signature n’existe dans cette interface." />
          </>
        )}
      </AsyncView>
    </>
  );
}
