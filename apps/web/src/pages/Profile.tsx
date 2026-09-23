import { useEffect, useState, type FormEvent } from 'react';
import type { DeviceSessionListResponse, ProfileResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { useAsync } from '../lib/useAsync.ts';
import { useAction } from '../lib/useAction.ts';
import { formatDate, formatRelative } from '../lib/format.ts';
import { initialsOf } from '../lib/initials.ts';
import { PageHeader, Card } from '../components/ui/Card.tsx';
import { AsyncView } from '../components/ui/AsyncView.tsx';
import { ActionFeedback } from '../components/ui/ActionFeedback.tsx';
import { SkeletonLines } from '../components/ui/Skeleton.tsx';
import { Badge } from '../components/ui/Stat.tsx';
import { TextField } from '../components/ui/Fields.tsx';
import { IconDevice, IconLogout, IconShield } from '../components/ui/Icons.tsx';
import { MembersPanel, PasswordPanel } from '../components/security/AccountsPanel.tsx';

/** Profil : identité, e-mail, sécurité, appareils connectés et membres. */
export function ProfilePage() {
  const { logout } = useAuth();
  const profile = useAsync<ProfileResponse>((signal) => request<ProfileResponse>('/api/auth/me', { signal }), []);

  return (
    <>
      <PageHeader title="Profil" subtitle="Vos informations, votre sécurité et les appareils connectés à votre compte." />
      <AsyncView
        loading={profile.loading}
        error={profile.error}
        data={profile.data}
        onRetry={profile.reload}
        skeleton={<SkeletonLines lines={5} />}
      >
        {(data) => (
          <>
            <section className="profile-head">
              <span className="avatar avatar-lg" aria-hidden="true">
                {initialsOf(data.displayName ?? data.username)}
              </span>
              <div>
                <h2 data-testid="profile-name">{data.displayName ?? data.username ?? 'Mon compte'}</h2>
                <p className="muted">
                  {data.username === null ? 'Compte principal' : `@${data.username}`} ·{' '}
                  {data.role === 'OWNER' ? 'Propriétaire' : 'Membre'} · depuis le {formatDate(data.createdAt)}
                </p>
              </div>
            </section>

            <ProfileForm profile={data} onSaved={profile.reload} />

            <h2 className="section-title">Sécurité</h2>
            <PasswordPanel />
            <DevicesPanel />

            {data.role === 'OWNER' && <MembersPanel />}

            <Card>
              <div className="page-head" style={{ padding: 0, alignItems: 'center' }}>
                <div>
                  <h2 className="card-title">Se déconnecter</h2>
                  <p className="card-subtitle">Ferme la session sur cet appareil uniquement.</p>
                </div>
                <button type="button" className="btn btn-danger" onClick={() => void logout()}>
                  <IconLogout size={18} /> Se déconnecter
                </button>
              </div>
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}

function ProfileForm({ profile, onSaved }: { readonly profile: ProfileResponse; readonly onSaved: () => void }) {
  const { refresh } = useAuth();
  const save = useAction();
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [email, setEmail] = useState(profile.email ?? '');
  const [username, setUsername] = useState(profile.username ?? '');

  useEffect(() => {
    setDisplayName(profile.displayName ?? '');
    setEmail(profile.email ?? '');
    setUsername(profile.username ?? '');
  }, [profile]);

  const changed =
    displayName.trim() !== (profile.displayName ?? '') ||
    email.trim().toLowerCase() !== (profile.email ?? '') ||
    username.trim().toLowerCase() !== (profile.username ?? '');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.run(async () => {
      await request<ProfileResponse>('/api/auth/me', {
        method: 'PATCH',
        json: {
          displayName: displayName.trim() === '' ? null : displayName.trim(),
          email: email.trim() === '' ? null : email.trim(),
          ...(username.trim() === '' || username.trim().toLowerCase() === profile.username
            ? {}
            : { username: username.trim().toLowerCase() }),
        },
      });
      onSaved();
      refresh();
      return 'Profil enregistré.';
    });
  };

  return (
    <Card title="Informations personnelles">
      <form className="form-grid" onSubmit={submit}>
        <TextField
          label="Nom affiché"
          value={displayName}
          onChange={setDisplayName}
          data-testid="profile-display-name"
          autoComplete="name"
        />
        <TextField
          label="Identifiant"
          value={username}
          onChange={setUsername}
          data-testid="profile-username"
          autoCapitalize="none"
          spellCheck={false}
          hint="Sert à vous connecter."
        />
        <TextField
          label="E-mail"
          type="email"
          value={email}
          onChange={setEmail}
          data-testid="profile-email"
          autoComplete="email"
          hint="Pour recevoir un lien si vous oubliez votre mot de passe. Stocké chiffré sur votre serveur."
        />
        <div className="card-actions-row">
          <button type="submit" className="btn btn-primary" data-testid="profile-save" disabled={save.pending || !changed}>
            {save.pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <ActionFeedback state={save} />
        </div>
      </form>
    </Card>
  );
}

function DevicesPanel() {
  const { refresh } = useAuth();
  const devices = useAsync<DeviceSessionListResponse>(
    (signal) => request<DeviceSessionListResponse>('/api/auth/sessions', { signal }),
    [],
  );
  const others = useAction();
  const count = devices.data?.sessions.length ?? 0;

  const revoke = (id: string, current: boolean): void => {
    void request<unknown>(`/api/auth/sessions/${id}`, { method: 'DELETE' })
      .then(() => (current ? refresh() : devices.reload()))
      .catch(() => devices.reload());
  };

  return (
    <Card
      title="Appareils connectés"
      subtitle="Chaque appareil garde sa session tant qu’il est utilisé. Fermez celles que vous ne reconnaissez pas."
      actions={
        count > 1 ? (
          <button
            type="button"
            className="btn"
            data-testid="logout-others"
            disabled={others.pending}
            onClick={() =>
              void others.run(async () => {
                const result = await request<{ closed: number }>('/api/auth/sessions/logout-others', { method: 'POST' });
                devices.reload();
                return `${result.closed} autre(s) appareil(s) déconnecté(s).`;
              })
            }
          >
            Déconnecter les autres appareils
          </button>
        ) : undefined
      }
    >
      <ActionFeedback state={others} />
      {devices.loading && devices.data === null ? (
        <SkeletonLines lines={2} />
      ) : (
        <ul className="list" data-testid="devices">
          {(devices.data?.sessions ?? []).map((device) => (
            <li key={device.id} className="list-row">
              <span className="logo" aria-hidden="true">
                <IconDevice size={20} />
              </span>
              <span className="list-row-main">
                <strong>
                  {device.device} {device.current && <Badge tone="ok">Cet appareil</Badge>}
                </strong>
                <span>
                  Actif {formatRelative(device.lastSeenAt)}
                  {device.ip === null ? '' : ` · ${device.ip}`} · connecté le {formatDate(device.createdAt)}
                </span>
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => revoke(device.id, device.current)}>
                {device.current ? 'Déconnecter' : 'Fermer'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="readonly-note">
        <IconShield size={16} /> Les jetons de session sont stockés hachés : même la base de données ne permet pas de les
        réutiliser.
      </p>
    </Card>
  );
}
