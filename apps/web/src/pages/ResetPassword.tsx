import { useEffect, useState, type FormEvent } from 'react';
import type { RecoveryResponse } from '@suiviinvest/api-contract';
import { errorMessage, request } from '../lib/api.ts';
import { MIN_PASSWORD_LENGTH } from '../lib/password.ts';
import { AuthBrand, AuthLayout } from '../components/security/AuthLayout.tsx';
import { RecoveryCodeNotice } from '../components/security/RecoveryCodeNotice.tsx';
import { PasswordField } from '../components/ui/Fields.tsx';

/**
 * Page ouverte depuis le lien reçu par e-mail (`/reinitialiser?token=…`).
 * Le jeton est à usage unique et expire après 30 minutes.
 */
export function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [valid, setValid] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  useEffect(() => {
    if (token === '') {
      setValid(false);
      return;
    }
    void request<{ valid: boolean }>('/api/auth/reset', { query: { token } })
      .then((result) => setValid(result.valid))
      .catch(() => setValid(false));
  }, [token]);

  const leave = (): void => {
    window.location.replace('/');
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await request<RecoveryResponse>('/api/auth/reset', {
        method: 'POST',
        json: { token, newPassword: password },
      });
      setIssuedCode(result.recoveryCode);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  if (issuedCode !== null) {
    return (
      <AuthLayout>
        <div className="login-card">
          <RecoveryCodeNotice code={issuedCode} onDone={leave} />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      {valid === false ? (
        <div className="login-card">
          <AuthBrand />
          <h1 className="login-title">Lien expiré</h1>
          <p className="login-lead">
            Ce lien n’est plus valable : il a déjà servi ou a dépassé 30 minutes. Refaites une demande depuis l’écran de
            connexion.
          </p>
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={leave}>
            Revenir à la connexion
          </button>
        </div>
      ) : (
        <form className="login-card" onSubmit={(event) => void submit(event)}>
          <AuthBrand />
          <h1 className="login-title">Nouveau mot de passe</h1>
          <p className="login-lead">Choisissez un mot de passe que vous n’utilisez nulle part ailleurs.</p>
          <PasswordField
            label="Nouveau mot de passe"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            showStrength
            required
          />
          <PasswordField
            label="Confirmer le mot de passe"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            required
          />
          {error !== null && (
            <p className="feedback feedback-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn btn-primary btn-lg btn-block"
            disabled={valid !== true || pending || password.length < MIN_PASSWORD_LENGTH || password !== confirm}
          >
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <p className="muted small">Toutes vos sessions ouvertes seront déconnectées.</p>
        </form>
      )}
    </AuthLayout>
  );
}
