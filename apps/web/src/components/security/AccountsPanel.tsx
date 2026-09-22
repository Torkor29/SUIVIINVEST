import { useState, type FormEvent } from 'react';
import type { AccountCreatedResponse, AccountListResponse, AccountSummaryDto, ChangePasswordResponse } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useAsync } from '../../lib/useAsync.ts';
import { useAction } from '../../lib/useAction.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Card } from '../ui/Card.tsx';
import { Badge } from '../ui/Stat.tsx';
import { formatDate } from '../../lib/format.ts';
import { RecoveryCodeNotice } from './RecoveryCodeNotice.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';

/**
 * Sécurité du compte : changement de mot de passe et gestion des comptes.
 *
 * Deux principes visibles ici :
 *  - aucun mot de passe n'est jamais relu : on ne peut que le REMPLACER, et
 *    l'ancien est exigé pour un changement volontaire ;
 *  - le code de récupération n'apparaît qu'à sa création ou à sa rotation.
 *
 * Rappel affiché à l'utilisateur : un compte supplémentaire ouvre le MÊME
 * patrimoine — les données ne sont pas cloisonnées par utilisateur.
 */
export function AccountsPanel() {
  const { session, refresh } = useAuth();
  const accounts = useAsync<AccountListResponse>(async (signal) => {
    // La liste n'est servie qu'au propriétaire : un membre n'appelle rien.
    if (session?.role !== 'OWNER') return { accounts: [] };
    return request<AccountListResponse>('/api/auth/accounts', { signal });
  }, [session?.role]);
  const create = useAction();
  const password = useAction();

  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [issuedFor, setIssuedFor] = useState<string>('votre compte');

  // création
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [ownerUsername, setOwnerUsername] = useState('');

  // changement de mot de passe
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const isOwner = session?.role === 'OWNER';
  const ownerNeedsUsername = isOwner && session?.username === null;

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (nextPassword !== confirmPassword) {
      password.reset();
      return;
    }
    void password.run(async () => {
      const result = await request<ChangePasswordResponse>('/api/auth/password', {
        method: 'POST',
        json: { currentPassword, newPassword: nextPassword },
      });
      setIssuedCode(result.recoveryCode);
      setIssuedFor(session?.username ?? 'votre compte');
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      // Le serveur a révoqué toutes les sessions : on repart de l'écran de connexion.
      return 'Mot de passe remplacé. Toutes les sessions ont été déconnectées.';
    });
  };

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void create.run(async () => {
      const result = await request<AccountCreatedResponse>('/api/auth/accounts', {
        method: 'POST',
        json: {
          username: newUsername,
          password: newAccountPassword,
          ...(newDisplayName === '' ? {} : { displayName: newDisplayName }),
          ...(ownerNeedsUsername && ownerUsername !== '' ? { ownerUsername } : {}),
        },
      });
      setIssuedCode(result.recoveryCode);
      setIssuedFor(String(result.account.username ?? 'le nouveau compte'));
      setNewUsername('');
      setNewDisplayName('');
      setNewAccountPassword('');
      setOwnerUsername('');
      accounts.reload();
      return `Compte ${result.account.username} créé — notez son code de récupération.`;
    });
  };

  const toggleAccount = (account: AccountSummaryDto): void => {
    void request<AccountSummaryDto>(`/api/auth/accounts/${account.id}`, {
      method: 'PATCH',
      json: { disabled: !account.disabled },
    })
      .then(() => accounts.reload())
      .catch(() => undefined);
  };

  const rotateCode = (account: AccountSummaryDto): void => {
    void request<{ recoveryCode: string }>(`/api/auth/accounts/${account.id}/recovery`, {
      method: 'POST',
    })
      .then((result) => {
        setIssuedCode(result.recoveryCode);
        setIssuedFor(String(account.username ?? 'ce compte'));
      })
      .catch(() => undefined);
  };

  if (issuedCode !== null) {
    return (
      <Card title="Code de récupération" subtitle="À conserver hors de l’application.">
        <RecoveryCodeNotice
          code={issuedCode}
          subject={issuedFor}
          onDone={() => {
            setIssuedCode(null);
            refresh();
          }}
        />
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Mon mot de passe"
        subtitle="Le mot de passe n’est jamais lisible : il est haché (Argon2id) et ne peut qu’être remplacé."
      >
        <form onSubmit={submitPassword}>
          <label className="field">
            <span className="field-label">Mot de passe actuel</span>
            <input
              className="input"
              type="password"
              data-testid="current-password"
              value={currentPassword}
              autoComplete="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Nouveau mot de passe (10 caractères minimum)</span>
            <input
              className="input"
              type="password"
              data-testid="new-password"
              value={nextPassword}
              autoComplete="new-password"
              onChange={(event) => setNextPassword(event.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Confirmer</span>
            <input
              className="input"
              type="password"
              data-testid="confirm-password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </label>
          {nextPassword !== '' && confirmPassword !== '' && nextPassword !== confirmPassword && (
            <p className="feedback feedback-error">Les deux mots de passe ne sont pas identiques.</p>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="change-password"
            disabled={
              password.pending ||
              currentPassword === '' ||
              nextPassword === '' ||
              nextPassword !== confirmPassword
            }
          >
            Remplacer mon mot de passe
          </button>
          <ActionFeedback state={password} />
          <p className="muted small">
            Un changement de mot de passe déconnecte <strong>toutes</strong> les sessions et émet un
            nouveau code de récupération : l’ancien cesse immédiatement de fonctionner.
          </p>
        </form>
      </Card>

      {isOwner && (
        <Card
          title="Comptes"
          subtitle="Un compte supplémentaire ouvre le même patrimoine : les données ne sont pas séparées par utilisateur."
        >
          {accounts.loading && accounts.data === null ? (
            <SkeletonLines lines={4} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Identifiant</th>
                    <th>Rôle</th>
                    <th>État</th>
                    <th>Dernière connexion</th>
                    <th>Code</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {(accounts.data?.accounts ?? []).map((account) => (
                    <tr key={account.id} data-testid={`account-${account.username ?? account.id}`}>
                      <td>
                        <strong>{account.username ?? '(sans identifiant)'}</strong>
                        {account.displayName !== null && (
                          <span className="muted small"> — {account.displayName}</span>
                        )}
                      </td>
                      <td>{account.role === 'OWNER' ? 'Propriétaire' : 'Membre'}</td>
                      <td>
                        <Badge tone={account.disabled ? 'danger' : 'ok'}>
                          {account.disabled ? 'Désactivé' : 'Actif'}
                        </Badge>
                      </td>
                      <td>{account.lastLoginAt === null ? 'jamais' : formatDate(account.lastLoginAt)}</td>
                      <td>
                        {account.hasRecoveryCode ? (
                          <span className="muted small">défini (non relisible)</span>
                        ) : (
                          <span className="tone-down">absent</span>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => rotateCode(account)}
                        >
                          Nouveau code
                        </button>
                        {account.username !== session?.username && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => toggleAccount(account)}
                          >
                            {account.disabled ? 'Réactiver' : 'Désactiver'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>Ajouter un compte</h3>
          <form onSubmit={submitCreate}>
            <label className="field">
              <span className="field-label">Identifiant (3 à 32 caractères, minuscules)</span>
              <input
                className="input"
                type="text"
                data-testid="new-account-username"
                value={newUsername}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setNewUsername(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Nom affiché (facultatif)</span>
              <input
                className="input"
                type="text"
                value={newDisplayName}
                onChange={(event) => setNewDisplayName(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Mot de passe du nouveau compte (10 caractères minimum)</span>
              <input
                className="input"
                type="password"
                data-testid="new-account-password"
                value={newAccountPassword}
                autoComplete="new-password"
                onChange={(event) => setNewAccountPassword(event.target.value)}
                required
              />
            </label>
            {ownerNeedsUsername && (
              <label className="field">
                <span className="field-label">
                  Votre identifiant (obligatoire : vous n’en avez pas encore)
                </span>
                <input
                  className="input"
                  type="text"
                  data-testid="owner-username"
                  value={ownerUsername}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setOwnerUsername(event.target.value)}
                  required
                />
              </label>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="create-account"
              disabled={create.pending || newUsername === '' || newAccountPassword === ''}
            >
              Créer le compte
            </button>
            <ActionFeedback state={create} />
          </form>

          <p className="muted small">
            {accounts.data?.accounts.length ?? 0} compte(s) · hachage Argon2id (m=19456 KiB, t=2, p=1) ·
            code de récupération en SHA-256, jamais relisible.
          </p>
        </Card>
      )}
    </>
  );
}