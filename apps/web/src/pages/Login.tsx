import { useState, type FormEvent } from 'react';
import type { RecoveryResponse } from '@suiviinvest/api-contract';
import { useAuth } from '../lib/auth.tsx';
import { errorMessage, isMockEnabled, request, setMockEnabled } from '../lib/api.ts';
import { IconLock } from '../components/ui/Icons.tsx';
import { ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';
import { RecoveryCodeNotice } from '../components/security/RecoveryCodeNotice.tsx';

type Mode = 'login' | 'recovery';

/**
 * Écran de connexion.
 *
 * Trois parcours cohabitent :
 *  - création du premier compte (avec affichage UNIQUE du code de récupération) ;
 *  - connexion, avec identifiant dès qu'un compte en porte un ;
 *  - mot de passe oublié : récupération par code, sans e-mail ni accès serveur.
 */
export function LoginPage() {
  const { session, login, setup, refresh, error: bootError } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodeInput, setRecoveryCodeInput] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsSetup = session?.needsSetup ?? false;
  const usernameRequired = (session?.usernameRequired ?? false) || needsSetup;
  const mock = isMockEnabled();

  /** Bascule le drapeau runtime puis recharge : l'API n'est pas nécessaire. */
  const enableMock = (): void => {
    setMockEnabled(true);
    window.location.reload();
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (needsSetup) {
        const result = await setup(password, usernameRequired && username !== '' ? username : null);
        // Le code n'est affiché qu'ici : on bloque l'entrée tant qu'il n'est pas vu.
        setIssuedCode(result.recoveryCode);
        return;
      }
      await login(password, usernameRequired && username !== '' ? username : null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const submitRecovery = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await request<RecoveryResponse>('/api/auth/recovery', {
        method: 'POST',
        json: {
          recoveryCode: recoveryCodeInput,
          newPassword,
          ...(username === '' ? {} : { username }),
        },
      });
      setIssuedCode(result.recoveryCode);
      setMode('login');
      setUsername(result.username ?? username);
      setPassword('');
      setRecoveryCodeInput('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  // Code fraîchement émis (création de compte ou récupération) : à noter MAINTENANT.
  if (issuedCode !== null) {
    return (
      <div className="login">
        <div className="card login-card">
          <RecoveryCodeNotice
            code={issuedCode}
            onDone={() => {
              setIssuedCode(null);
              // Création du compte : la session n'a pas encore été ouverte, c'est
              // maintenant qu'on entre. Récupération : on revient à la connexion.
              if (needsSetup) refresh();
              else window.location.reload();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form
        className="card login-card"
        onSubmit={(event) => void (mode === 'login' ? submitLogin(event) : submitRecovery(event))}
      >
        <div className="brand brand-login">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-text">
            <strong>SuiviInvest</strong>
            <small>Patrimoine personnel — lecture seule</small>
          </span>
        </div>

        <h1 className="login-title">
          {mode === 'recovery'
            ? 'Mot de passe oublié'
            : needsSetup
              ? 'Créer votre compte'
              : 'Déverrouiller vos données'}
        </h1>
        <p className="muted small">
          {mode === 'recovery'
            ? 'Saisissez le code de récupération remis à la création du compte, puis choisissez un nouveau mot de passe. Aucun e-mail n’est nécessaire : l’application est auto-hébergée.'
            : needsSetup
              ? 'Le mot de passe protège l’accès à l’interface ; les secrets des connecteurs restent chiffrés côté serveur.'
              : 'Saisissez vos identifiants pour reprendre la session.'}
        </p>

        {(mode === 'recovery' || usernameRequired) && (
          <label className="field">
            <span className="field-label">
              Identifiant{mode === 'recovery' || needsSetup ? ' (facultatif si un seul compte)' : ''}
            </span>
            <input
              className="input"
              type="text"
              name="username"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
        )}

        {mode === 'login' ? (
          <label className="field">
            <span className="field-label">Mot de passe</span>
            <input
              className="input"
              type="password"
              value={password}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Code de récupération</span>
              <input
                className="input"
                type="text"
                data-testid="recovery-code"
                value={recoveryCodeInput}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
                onChange={(event) => setRecoveryCodeInput(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Nouveau mot de passe (10 caractères minimum)</span>
              <input
                className="input"
                type="password"
                data-testid="recovery-new-password"
                value={newPassword}
                autoComplete="new-password"
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Confirmer le nouveau mot de passe</span>
              <input
                className="input"
                type="password"
                data-testid="recovery-confirm-password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
            </label>
          </>
        )}

        {error !== null && (
          <p className="feedback feedback-error" role="alert">
            {error}
          </p>
        )}
        {error === null && bootError !== null && <p className="muted small">{bootError}</p>}

        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={pending || (mode === 'login' ? password === '' : recoveryCodeInput === '' || newPassword === '')}
        >
          <IconLock size={16} />
          {pending
            ? 'Vérification…'
            : mode === 'recovery'
              ? 'Définir le nouveau mot de passe'
              : needsSetup
                ? 'Créer le compte'
                : 'Entrer'}
        </button>

        {!needsSetup && (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            data-testid="forgot-password"
            onClick={() => {
              setMode(mode === 'login' ? 'recovery' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Mot de passe oublié ?' : 'Revenir à la connexion'}
          </button>
        )}

        {mock ? (
          <p className="muted small">Mode maquette actif : n’importe quel mot de passe ouvre la démonstration.</p>
        ) : (
          <button type="button" className="btn btn-ghost btn-block" onClick={enableMock}>
            Explorer sans API (mode maquette)
          </button>
        )}
        <ReadOnlyNote />
      </form>
    </div>
  );
}