import { useState, type FormEvent } from 'react';
import type {
  AccountCreatedResponse,
  AccountListResponse,
  AccountSummaryDto,
  ChangePasswordResponse,
} from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAuth } from '../../lib/auth.tsx';
import { useAsync } from '../../lib/useAsync.ts';
import { useAction } from '../../lib/useAction.ts';
import { formatRelative } from '../../lib/format.ts';
import { initialsOf } from '../../lib/initials.ts';
import { MIN_PASSWORD_LENGTH } from '../../lib/password.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Card } from '../ui/Card.tsx';
import { Badge } from '../ui/Stat.tsx';
import { PasswordField, TextField } from '../ui/Fields.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import { RecoveryCodeNotice } from './RecoveryCodeNotice.tsx';

/** Code de secours fraîchement émis, à afficher une seule fois. */
interface IssuedCode {
  readonly code: string;
  readonly subject: string;
}

function IssuedCodeCard({ issued, onDone }: { readonly issued: IssuedCode; readonly onDone: () => void }) {
  return (
    <Card>
      <div className="form-stack">
        <RecoveryCodeNotice code={issued.code} subject={issued.subject} onDone={onDone} />
      </div>
    </Card>
  );
}

/**
 * Mot de passe et code de secours du compte connecté.
 *
 * Aucun mot de passe n'est jamais relu : il ne peut qu'être remplacé, et
 * l'actuel est exigé. Un changement déconnecte tous les appareils.
 */
export function PasswordPanel() {
  const { session, refresh } = useAuth();
  const password = useAction();
  const rotate = useAction();
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const mismatch = nextPassword !== '' && confirmPassword !== '' && nextPassword !== confirmPassword;
  const subject = session?.username === null || session?.username === undefined ? 'votre compte' : `@${session.username}`;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (nextPassword !== confirmPassword) return;
    void password.run(async () => {
      const result = await request<ChangePasswordResponse>('/api/auth/password', {
        method: 'POST',
        json: { currentPassword, newPassword: nextPassword },
      });
      setIssued({ code: result.recoveryCode, subject });
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      return 'Mot de passe modifié.';
    });
  };

  const newCode = (): void => {
    void rotate.run(async () => {
      const me = await request<{ id: string }>('/api/auth/me');
      const result = await request<{ recoveryCode: string }>(`/api/auth/accounts/${me.id}/recovery`, { method: 'POST' });
      setIssued({ code: result.recoveryCode, subject });
      return 'Nouveau code émis.';
    });
  };

  if (issued !== null) {
    return <IssuedCodeCard issued={issued} onDone={() => {
          setIssued(null);
          refresh();
        }} />;
  }

  return (
    <>
      <Card title="Mot de passe" subtitle="Changer de mot de passe déconnecte tous vos appareils.">
        <form className="form-stack" onSubmit={submit}>
          <PasswordField
            label="Mot de passe actuel"
            value={currentPassword}
            onChange={setCurrentPassword}
            data-testid="current-password"
            autoComplete="current-password"
            required
          />
          <PasswordField
            label="Nouveau mot de passe"
            value={nextPassword}
            onChange={setNextPassword}
            data-testid="new-password"
            autoComplete="new-password"
            showStrength
            required
          />
          <PasswordField
            label="Confirmer le nouveau mot de passe"
            value={confirmPassword}
            onChange={setConfirmPassword}
            data-testid="confirm-password"
            autoComplete="new-password"
            required
          />
          {mismatch && <p className="feedback feedback-error">Les deux mots de passe ne sont pas identiques.</p>}
          <div>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="change-password"
              disabled={
                password.pending ||
                currentPassword === '' ||
                nextPassword.length < MIN_PASSWORD_LENGTH ||
                nextPassword !== confirmPassword
              }
            >
              {password.pending ? 'Enregistrement…' : 'Changer le mot de passe'}
            </button>
          </div>
          <ActionFeedback state={password} />
        </form>
      </Card>

      <Card
        title="Code de secours"
        subtitle="Il permet de choisir un nouveau mot de passe si vous l’oubliez, même sans e-mail."
      >
        <p className="muted small">
          Le code n’est jamais stocké en clair et ne peut pas être réaffiché. Si vous l’avez perdu, émettez-en un
          nouveau : l’ancien cessera aussitôt de fonctionner.
        </p>
        <div className="card-actions-row">
          <button type="button" className="btn" data-testid="rotate-recovery" disabled={rotate.pending} onClick={newCode}>
            {rotate.pending ? 'Émission…' : 'Émettre un nouveau code'}
          </button>
        </div>
        <ActionFeedback state={rotate} />
      </Card>
    </>
  );
}

/**
 * Comptes de l'application (propriétaire uniquement).
 *
 * Rappel affiché : un compte supplémentaire ouvre le MÊME patrimoine — les
 * données ne sont pas séparées par utilisateur.
 */
export function MembersPanel() {
  const { session, refresh } = useAuth();
  const accounts = useAsync<AccountListResponse>(async (signal) => {
    if (session?.role !== 'OWNER') return { accounts: [] };
    return request<AccountListResponse>('/api/auth/accounts', { signal });
  }, [session?.role]);
  const create = useAction();
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newAccountPassword, setNewAccountPassword] = useState('');
  const [ownerUsername, setOwnerUsername] = useState('');
  const ownerNeedsUsername = session?.role === 'OWNER' && session.username === null;

  if (session?.role !== 'OWNER') return null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void create.run(async () => {
      const result = await request<AccountCreatedResponse>('/api/auth/accounts', {
        method: 'POST',
        json: {
          username: newUsername.trim().toLowerCase(),
          password: newAccountPassword,
          ...(newDisplayName.trim() === '' ? {} : { displayName: newDisplayName.trim() }),
          ...(newEmail.trim() === '' ? {} : { email: newEmail.trim() }),
          ...(ownerNeedsUsername && ownerUsername !== '' ? { ownerUsername: ownerUsername.trim().toLowerCase() } : {}),
        },
      });
      setIssued({ code: result.recoveryCode, subject: `@${result.account.username ?? 'nouveau'}` });
      setNewUsername('');
      setNewDisplayName('');
      setNewEmail('');
      setNewAccountPassword('');
      setOwnerUsername('');
      accounts.reload();
      return `Compte @${result.account.username} créé.`;
    });
  };

  const toggle = (account: AccountSummaryDto): void => {
    void request<AccountSummaryDto>(`/api/auth/accounts/${account.id}`, {
      method: 'PATCH',
      json: { disabled: !account.disabled },
    })
      .then(() => accounts.reload())
      .catch(() => undefined);
  };

  const rotateFor = (account: AccountSummaryDto): void => {
    void request<{ recoveryCode: string }>(`/api/auth/accounts/${account.id}/recovery`, { method: 'POST' })
      .then((result) =>
        setIssued({ code: result.recoveryCode, subject: `@${account.username ?? 'compte'}` }),
      )
      .catch(() => undefined);
  };

  if (issued !== null) {
    return <IssuedCodeCard issued={issued} onDone={() => {
          setIssued(null);
          refresh();
        }} />;
  }

  return (
    <Card
      title="Membres"
      subtitle="Chaque membre voit le même patrimoine que vous : n’invitez que des personnes de confiance."
    >
      {accounts.loading && accounts.data === null ? (
        <SkeletonLines lines={3} />
      ) : (
        <ul className="list">
          {(accounts.data?.accounts ?? []).map((account) => {
            const self = account.username === session.username;
            return (
              <li key={account.id} className="list-row" data-testid={`account-${account.username ?? account.id}`}>
                <span className="avatar" aria-hidden="true">
                  {initialsOf(account.displayName ?? account.username)}
                </span>
                <span className="list-row-main">
                  <strong>
                    {account.displayName ?? account.username ?? 'Compte principal'}
                    {self && <span className="muted"> · vous</span>}
                  </strong>
                  <span>
                    {account.username === null ? 'sans identifiant' : `@${account.username}`} ·{' '}
                    {account.role === 'OWNER' ? 'Propriétaire' : 'Membre'} ·{' '}
                    {account.lastLoginAt === null ? 'jamais connecté' : `vu ${formatRelative(account.lastLoginAt)}`}
                  </span>
                </span>
                {account.disabled && <Badge tone="danger">Désactivé</Badge>}
                {!self && (
                  <span className="page-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => rotateFor(account)}>
                      Nouveau code
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => toggle(account)}>
                      {account.disabled ? 'Réactiver' : 'Désactiver'}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h3>Ajouter un membre</h3>
      <form className="form-grid" onSubmit={submit}>
        <TextField
          label="Identifiant"
          value={newUsername}
          onChange={setNewUsername}
          data-testid="new-account-username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <TextField label="Nom (facultatif)" value={newDisplayName} onChange={setNewDisplayName} />
        <TextField label="E-mail (facultatif)" type="email" value={newEmail} onChange={setNewEmail} />
        <PasswordField
          label="Mot de passe provisoire"
          value={newAccountPassword}
          onChange={setNewAccountPassword}
          data-testid="new-account-password"
          autoComplete="new-password"
          showStrength
          required
        />
        {ownerNeedsUsername && (
          <TextField
            label="Votre identifiant (à choisir d’abord)"
            value={ownerUsername}
            onChange={setOwnerUsername}
            data-testid="owner-username"
            autoCapitalize="none"
            spellCheck={false}
            hint="Votre compte n’a pas encore d’identifiant : il en faut un dès qu’il y a plusieurs comptes."
            required
          />
        )}
        <div className="card-actions-row">
          <button
            type="submit"
            className="btn btn-primary"
            data-testid="create-account"
            disabled={create.pending || newUsername.trim().length < 3 || newAccountPassword.length < MIN_PASSWORD_LENGTH}
          >
            {create.pending ? 'Création…' : 'Créer le compte'}
          </button>
          <ActionFeedback state={create} />
        </div>
      </form>
    </Card>
  );
}

/** Ancienne API du module : conservée pour les imports existants. */
export function AccountsPanel() {
  return (
    <>
      <PasswordPanel />
      <MembersPanel />
    </>
  );
}
