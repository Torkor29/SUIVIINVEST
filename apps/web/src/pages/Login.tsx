import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth.tsx';
import { errorMessage, isMockEnabled, setMockEnabled } from '../lib/api.ts';
import { IconLock } from '../components/ui/Icons.tsx';
import { ReadOnlyNote } from '../components/ui/AllocationLegend.tsx';

/** Écran de connexion : création du mot de passe au premier lancement, puis déverrouillage. */
export function LoginPage() {
  const { session, login, setup, error: bootError } = useAuth();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsSetup = session?.needsSetup ?? false;
  const mock = isMockEnabled();

  /** Bascule le drapeau runtime puis recharge : l'API n'est pas nécessaire. */
  const enableMock = (): void => {
    setMockEnabled(true);
    window.location.reload();
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (needsSetup) await setup(password);
      else await login(password);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand brand-login">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-text">
            <strong>SuiviInvest</strong>
            <small>Patrimoine personnel — lecture seule</small>
          </span>
        </div>
        <h1 className="login-title">{needsSetup ? 'Créer votre mot de passe' : 'Déverrouiller vos données'}</h1>
        <p className="muted small">
          {needsSetup
            ? 'Le mot de passe protège l’accès à l’interface ; les secrets des connecteurs restent chiffrés côté serveur.'
            : 'Saisissez votre mot de passe pour reprendre la session.'}
        </p>
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
        {error !== null && (
          <p className="feedback feedback-error" role="alert">
            {error}
          </p>
        )}
        {error === null && bootError !== null && <p className="muted small">{bootError}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={pending || password === ''}>
          <IconLock size={16} />
          {pending ? 'Vérification…' : needsSetup ? 'Créer le mot de passe' : 'Entrer'}
        </button>
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
