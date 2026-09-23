import { useEffect, useState } from 'react';
import type { GoogleConfigResponse, GoogleStatusResponse, ProfileResponse } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useAsync } from '../../lib/useAsync.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Card } from '../ui/Card.tsx';
import { PasswordField, TextField } from '../ui/Fields.tsx';
import { Badge } from '../ui/Stat.tsx';

/** Messages associés aux issues renvoyées par le serveur (`?google=<code>`). */
const GOOGLE_MESSAGES: Readonly<Record<string, { readonly text: string; readonly tone: 'ok' | 'error' }>> = {
  welcome: { text: 'Compte créé avec Google. Bienvenue !', tone: 'ok' },
  linked: { text: 'Votre compte Google est lié : vous pourrez l’utiliser pour vous connecter.', tone: 'ok' },
  not_invited: {
    text: 'Ce compte Google n’a pas accès à ce patrimoine. Demandez au propriétaire de vous inviter avec cette adresse e-mail.',
    tone: 'error',
  },
  disabled: { text: 'Ce compte est désactivé.', tone: 'error' },
  other_account: { text: 'Cette adresse e-mail est déjà liée à un autre compte Google.', tone: 'error' },
  already_linked: { text: 'Ce compte Google est déjà lié à un autre compte SuiviInvest.', tone: 'error' },
  link_refused: { text: 'Liaison refusée : rouvrez votre profil et réessayez.', tone: 'error' },
  cancelled: { text: 'Connexion avec Google annulée.', tone: 'error' },
  expired: { text: 'La demande a expiré : cliquez de nouveau sur « Continuer avec Google ».', tone: 'error' },
  browser_mismatch: { text: 'Terminez la connexion dans le même navigateur que celui où vous l’avez commencée.', tone: 'error' },
  not_configured: { text: 'La connexion avec Google n’est pas encore configurée sur ce serveur.', tone: 'error' },
  email_unverified: { text: 'Votre adresse e-mail Google n’est pas confirmée.', tone: 'error' },
  token: { text: 'Google a refusé la connexion : vérifiez l’identifiant client et l’adresse de retour dans la console Google.', tone: 'error' },
  invalid_token: { text: 'Réponse de Google non valable. Réessayez.', tone: 'error' },
  error: { text: 'La connexion avec Google a échoué. Réessayez.', tone: 'error' },
};

export function googleMessage(code: string | null): { text: string; tone: 'ok' | 'error' } | null {
  if (code === null || code === '') return null;
  return GOOGLE_MESSAGES[code] ?? GOOGLE_MESSAGES.error ?? null;
}

/** Lit puis efface `?google=` de l'adresse (un rechargement ne réaffiche pas le message). */
export function useGoogleOutcome(): { text: string; tone: 'ok' | 'error' } | null {
  const [code] = useState<string | null>(() => new URLSearchParams(window.location.search).get('google'));
  useEffect(() => {
    if (code === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('google');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [code]);
  return googleMessage(code);
}

export function useGoogleEnabled(): boolean {
  const status = useAsync<GoogleStatusResponse>(
    (signal) => request<GoogleStatusResponse>('/api/auth/google/status', { signal }).catch(() => ({ enabled: false })),
    [],
  );
  return status.data?.enabled ?? false;
}

export function GoogleLogo({ size = 18 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Bouton « Continuer avec Google » : navigation vers le serveur, qui redirige vers Google. */
export function GoogleButton({ label = 'Continuer avec Google' }: { readonly label?: string }) {
  return (
    <a className="btn btn-lg btn-block btn-google" href="/api/auth/google/start" data-testid="google-sign-in">
      <GoogleLogo /> {label}
    </a>
  );
}

/** Message d'issue (connexion, liaison) affiché une seule fois. */
export function GoogleOutcome({ outcome }: { readonly outcome: { text: string; tone: 'ok' | 'error' } | null }) {
  if (outcome === null) return null;
  return (
    <p className={`feedback ${outcome.tone === 'ok' ? 'feedback-ok' : 'feedback-error'}`} role="status" data-testid="google-outcome">
      {outcome.text}
    </p>
  );
}

/** Profil : lier ou délier son compte Google. */
export function GoogleLinkCard({ profile, onChanged }: { readonly profile: ProfileResponse; readonly onChanged: () => void }) {
  const { session } = useAuth();
  const enabled = useGoogleEnabled();
  const unlink = useAction();
  const outcome = useGoogleOutcome();
  if (!enabled && !profile.googleLinked) return null;
  const linkUrl = `/api/auth/google/start?mode=link&csrf=${encodeURIComponent(session?.csrfToken ?? '')}`;
  return (
    <Card
      title="Connexion avec Google"
      subtitle="Connectez-vous d’un clic avec votre compte Google, sans mot de passe à retenir."
      actions={profile.googleLinked ? <Badge tone="ok">Lié</Badge> : <Badge tone="neutral">Non lié</Badge>}
    >
      <GoogleOutcome outcome={outcome} />
      {profile.googleLinked ? (
        <div className="form-stack">
          <p className="muted small">« Continuer avec Google » ouvre ce compte depuis l’écran de connexion.</p>
          {profile.passwordSet === false ? (
            <p className="muted small">Votre compte n’a pas de mot de passe : définissez-en un ci-dessous avant de pouvoir délier Google.</p>
          ) : (
            <div>
              <button
                type="button"
                className="btn"
                disabled={unlink.pending}
                data-testid="google-unlink"
                onClick={() =>
                  void unlink.run(async () => {
                    await request('/api/auth/google/link', { method: 'DELETE' });
                    onChanged();
                    return 'Compte Google délié.';
                  })
                }
              >
                Délier Google
              </button>
            </div>
          )}
          <ActionFeedback state={unlink} />
        </div>
      ) : (
        <a className="btn btn-google" href={linkUrl} data-testid="google-link">
          <GoogleLogo /> Lier mon compte Google
        </a>
      )}
    </Card>
  );
}

/** Paramètres (propriétaire) : identifiants de l'application Google. */
export function GoogleConfigCard() {
  const { session } = useAuth();
  const config = useAsync<GoogleConfigResponse | null>(
    async (signal) => (session?.role === 'OWNER' ? request<GoogleConfigResponse>('/api/auth/google/config', { signal }) : null),
    [session?.role],
  );
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const save = useAction();
  const remove = useAction();
  if (session?.role !== 'OWNER' || config.data === null || config.data === undefined) return null;
  const data = config.data;
  return (
    <Card
      title="Connexion avec Google"
      subtitle="Permet à vous et aux membres invités de se connecter avec leur compte Google."
      actions={data.configured ? <Badge tone="ok">Activée</Badge> : <Badge tone="neutral">À configurer</Badge>}
    >
      {data.source === 'env' ? (
        <p className="muted small">
          Réglée dans le fichier <code>.env</code> du serveur (identifiant client <code>{data.clientId}</code>).
        </p>
      ) : (
        <div className="form-stack">
          <ol className="steps-list">
            <li>
              Ouvrez{' '}
              <a className="btn-link" href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">
                la console Google Cloud
              </a>{' '}
              (créez un projet si besoin), puis « Clients » → « Créer un client » → type <strong>Application Web</strong>.
            </li>
            <li>
              Origine JavaScript autorisée : <code className="inline-code">{data.origin}</code>
            </li>
            <li>
              URI de redirection autorisé : <code className="inline-code" data-testid="google-redirect">{data.redirectUri}</code>
            </li>
            <li>Collez ici l’ID client et le code secret du client.</li>
          </ol>
          {data.configured && <p className="muted small">Identifiant actuel : <code>{data.clientId}</code></p>}
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void save.run(async () => {
                await request<GoogleConfigResponse>('/api/auth/google/config', {
                  method: 'PUT',
                  json: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
                });
                setClientSecret('');
                config.reload();
                return 'Connexion avec Google activée.';
              });
            }}
          >
            <TextField label="ID client" value={clientId} onChange={setClientId} placeholder="…apps.googleusercontent.com" spellCheck={false} required />
            <PasswordField label="Code secret du client" value={clientSecret} onChange={setClientSecret} autoComplete="off" required />
            <div className="card-actions-row">
              <button type="submit" className="btn btn-primary" disabled={save.pending}>
                {data.configured ? 'Remplacer' : 'Activer'}
              </button>
              {data.configured && (
                <button
                  type="button"
                  className="btn btn-link tone-down"
                  disabled={remove.pending}
                  onClick={() =>
                    void remove.run(async () => {
                      await request('/api/auth/google/config', { method: 'DELETE' });
                      config.reload();
                      return 'Connexion avec Google désactivée.';
                    })
                  }
                >
                  Désactiver
                </button>
              )}
            </div>
          </form>
          <ActionFeedback state={save} />
          <ActionFeedback state={remove} />
          <p className="muted small">
            Sécurité : seuls vous et les personnes invitées par leur adresse e-mail (Profil → Membres) peuvent se connecter.
            Un compte Google inconnu est refusé.
          </p>
        </div>
      )}
    </Card>
  );
}
