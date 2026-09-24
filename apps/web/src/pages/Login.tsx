import { useState, type FormEvent } from 'react';
import type { ForgotPasswordResponse, RecoveryResponse } from '@suiviinvest/api-contract';
import { useAuth } from '../lib/auth.tsx';
import { errorMessage, isMockEnabled, request, setMockEnabled } from '../lib/api.ts';
import { MIN_PASSWORD_LENGTH } from '../lib/password.ts';
import { AuthBrand, AuthLayout } from '../components/security/AuthLayout.tsx';
import { RecoveryCodeNotice } from '../components/security/RecoveryCodeNotice.tsx';
import { PasswordField, TextField } from '../components/ui/Fields.tsx';
import { IconArrowLeft, IconMail } from '../components/ui/Icons.tsx';
import { GoogleButton, GoogleOutcome, useGoogleEnabled, useGoogleOutcome } from '../components/security/GoogleSignIn.tsx';

type Mode = 'login' | 'forgot' | 'code' | 'sent' | 'register';

/**
 * Écrans d'accès :
 *  - création du premier compte (le code de secours est remis une seule fois) ;
 *  - connexion par identifiant ou e-mail ;
 *  - mot de passe oublié : lien par e-mail (si le serveur sait en envoyer) ou
 *    code de secours (fonctionne toujours, sans e-mail ni accès au serveur).
 */
export function LoginPage() {
  const { session, refresh } = useAuth();
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const needsSetup = session?.needsSetup ?? false;

  if (issuedCode !== null) {
    return (
      <AuthLayout>
        <div className="login-card">
          <RecoveryCodeNotice
            code={issuedCode}
            onDone={() => {
              setIssuedCode(null);
              // Création : la session n'est ouverte qu'après avoir vu le code.
              // Récupération : on revient à l'écran de connexion.
              if (needsSetup) refresh();
              else window.location.reload();
            }}
          />
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      {needsSetup ? <SetupForm onCode={setIssuedCode} /> : <SignInFlow onCode={setIssuedCode} />}
    </AuthLayout>
  );
}

/* ------------------------------------------------------------------ création */

function SetupForm({ onCode }: { readonly onCode: (code: string) => void }) {
  const { setup, error: bootError } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm !== '' && password !== confirm;
  const googleEnabled = useGoogleEnabled();
  const googleOutcome = useGoogleOutcome();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await setup({
        password,
        username: username.trim() === '' ? null : username.trim().toLowerCase(),
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        email: email.trim() === '' ? null : email.trim(),
      });
      onCode(result.recoveryCode);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="login-card" onSubmit={(event) => void submit(event)}>
      <AuthBrand />
      <h1 className="login-title">Créez votre compte</h1>
      <p className="login-lead">Quelques secondes suffisent. Ce compte sera le propriétaire de l’application.</p>
      <GoogleOutcome outcome={googleOutcome} />
      {googleEnabled && (
        <>
          <GoogleButton label="Créer mon compte avec Google" />
          <div className="login-divider">ou avec un mot de passe</div>
        </>
      )}

      <TextField label="Prénom ou nom" value={displayName} onChange={setDisplayName} autoComplete="name" />
      <TextField
        label="Identifiant"
        value={username}
        onChange={setUsername}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        minLength={3}
        maxLength={32}
        hint="3 à 32 caractères : lettres minuscules, chiffres, point ou tiret."
      />
      <TextField
        label="E-mail (facultatif)"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        hint="Pour recevoir un lien si vous oubliez votre mot de passe. Stocké chiffré."
      />
      <PasswordField
        label="Mot de passe"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        data-testid="setup-password"
        showStrength
        required
      />
      <PasswordField
        label="Confirmer le mot de passe"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        data-testid="setup-confirm"
        required
      />
      {mismatch && <p className="feedback feedback-error">Les deux mots de passe ne sont pas identiques.</p>}
      {error !== null && (
        <p className="feedback feedback-error" role="alert">
          {error}
        </p>
      )}
      {error === null && bootError !== null && <p className="muted small">{bootError}</p>}
      <button
        type="submit"
        className="btn btn-primary btn-lg btn-block"
        disabled={pending || username.trim().length < 3 || password.length < MIN_PASSWORD_LENGTH || password !== confirm}
      >
        {pending ? 'Création…' : 'Créer mon compte'}
      </button>
      <DemoLink />
    </form>
  );
}

/* ---------------------------------------------------- connexion et récupération */

function SignInFlow({ onCode }: { readonly onCode: (code: string) => void }) {
  const { session, login, error: bootError } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sentMessage, setSentMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRequired = session?.usernameRequired ?? false;
  const emailAvailable = session?.emailResetAvailable ?? false;
  const googleEnabled = useGoogleEnabled();
  const googleOutcome = useGoogleOutcome();

  const go = (next: Mode): void => {
    setMode(next);
    setError(null);
  };

  const run = async (action: () => Promise<void>): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  const submitLogin = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(() => login(password, identifier.trim() === '' ? null : identifier.trim()));
  };

  const submitForgot = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run(async () => {
      const result = await request<ForgotPasswordResponse>('/api/auth/forgot', {
        method: 'POST',
        json: { identifier: identifier.trim() },
      });
      setSentMessage(result.message);
      setMode('sent');
    });
  };

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    void run(async () => {
      const result = await request<RecoveryResponse>('/api/auth/recovery', {
        method: 'POST',
        json: {
          recoveryCode: code.trim(),
          newPassword,
          ...(identifier.trim() === '' ? {} : { username: identifier.trim() }),
        },
      });
      onCode(result.recoveryCode);
    });
  };

  const feedback = (
    <>
      {error !== null && (
        <p className="feedback feedback-error" role="alert">
          {error}
        </p>
      )}
      {error === null && bootError !== null && <p className="muted small">{bootError}</p>}
    </>
  );

  const back = (
    <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => go('login')}>
      <IconArrowLeft size={18} /> Retour
    </button>
  );

  if (mode === 'register') {
    return <RegisterForm onCode={onCode} onBack={() => go('login')} googleEnabled={googleEnabled} />;
  }

  if (mode === 'sent') {
    return (
      <div className="login-card">
        <AuthBrand />
        <span className="avatar avatar-lg" aria-hidden="true">
          <IconMail size={28} />
        </span>
        <h1 className="login-title">Vérifiez vos e-mails</h1>
        <p className="login-lead" data-testid="forgot-sent">
          {sentMessage}
        </p>
        <p className="muted small">Le lien est valable 30 minutes et ne fonctionne qu’une fois.</p>
        <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => go('login')}>
          Revenir à la connexion
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => go('code')}>
          Utiliser plutôt mon code de secours
        </button>
      </div>
    );
  }

  if (mode === 'forgot') {
    return (
      <form className="login-card" onSubmit={submitForgot}>
        {back}
        <h1 className="login-title">Mot de passe oublié</h1>
        <p className="login-lead">Indiquez votre identifiant ou votre e-mail : nous vous envoyons un lien pour en choisir un nouveau.</p>
        <TextField
          label="Identifiant ou e-mail"
          value={identifier}
          onChange={setIdentifier}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        {feedback}
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending || identifier.trim() === ''}>
          {pending ? 'Envoi…' : 'Recevoir un lien'}
        </button>
        <div className="login-divider">ou</div>
        <button type="button" className="btn btn-block" data-testid="use-recovery-code" onClick={() => go('code')}>
          J’ai un code de secours
        </button>
      </form>
    );
  }

  if (mode === 'code') {
    return (
      <form className="login-card" onSubmit={submitCode}>
        {back}
        <h1 className="login-title">Mot de passe oublié</h1>
        <p className="login-lead">
          Saisissez le code de secours remis à la création du compte, puis choisissez un nouveau mot de passe.
        </p>
        <TextField
          label={usernameRequired ? 'Identifiant ou e-mail' : 'Identifiant ou e-mail (facultatif)'}
          value={identifier}
          onChange={setIdentifier}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
        <TextField
          label="Code de secours"
          value={code}
          onChange={setCode}
          data-testid="recovery-code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
          required
        />
        <PasswordField
          label="Nouveau mot de passe"
          value={newPassword}
          onChange={setNewPassword}
          data-testid="recovery-new-password"
          autoComplete="new-password"
          showStrength
          required
        />
        <PasswordField
          label="Confirmer le nouveau mot de passe"
          value={confirm}
          onChange={setConfirm}
          data-testid="recovery-confirm-password"
          autoComplete="new-password"
          required
        />
        {feedback}
        <button
          type="submit"
          className="btn btn-primary btn-lg btn-block"
          disabled={pending || code.trim() === '' || newPassword.length < MIN_PASSWORD_LENGTH || newPassword !== confirm}
        >
          {pending ? 'Vérification…' : 'Définir le nouveau mot de passe'}
        </button>
      </form>
    );
  }

  return (
    <form className="login-card" onSubmit={submitLogin}>
      <AuthBrand />
      <h1 className="login-title">Bon retour</h1>
      <p className="login-lead">Connectez-vous pour retrouver votre patrimoine.</p>
      <GoogleOutcome outcome={googleOutcome} />
      {googleEnabled && (
        <>
          <GoogleButton />
          <div className="login-divider">ou</div>
        </>
      )}
      {usernameRequired && (
        <TextField
          label="Identifiant ou e-mail"
          value={identifier}
          onChange={setIdentifier}
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      )}
      <PasswordField
        label="Mot de passe"
        value={password}
        onChange={setPassword}
        data-testid="login-password"
        autoComplete="current-password"
        required
      />
      {feedback}
      <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={pending || password === ''}>
        {pending ? 'Connexion…' : 'Se connecter'}
      </button>
      {session?.registrationOpen === true && (
        <button type="button" className="btn btn-ghost btn-lg btn-block" data-testid="open-register" onClick={() => go('register')}>
          Créer un compte
        </button>
      )}
      <div className="login-links">
        <button
          type="button"
          className="btn btn-link"
          data-testid="forgot-password"
          onClick={() => go(emailAvailable ? 'forgot' : 'code')}
        >
          Mot de passe oublié ?
        </button>
        <DemoLink />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------- inscription */

function RegisterForm({
  onCode,
  onBack,
  googleEnabled,
}: {
  readonly onCode: (code: string) => void;
  readonly onBack: () => void;
  readonly googleEnabled: boolean;
}) {
  const { register } = useAuth();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm !== '' && password !== confirm;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password !== confirm) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await register({
        email: email.trim(),
        password,
        displayName: displayName.trim() === '' ? null : displayName.trim(),
      });
      onCode(result.recoveryCode);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="login-card" onSubmit={(event) => void submit(event)} data-testid="register-form">
      <AuthBrand />
      <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={onBack}>
        <IconArrowLeft size={18} /> Retour
      </button>
      <h1 className="login-title">Créer un compte</h1>
      <p className="login-lead">Votre espace est personnel : personne d’autre ne voit vos données.</p>
      {googleEnabled && (
        <>
          <GoogleButton label="S’inscrire avec Google" />
          <div className="login-divider">ou avec votre e-mail</div>
        </>
      )}
      <TextField label="Prénom ou nom (facultatif)" value={displayName} onChange={setDisplayName} autoComplete="name" />
      <TextField
        label="E-mail"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        data-testid="register-email"
        required
        hint="Il sert à vous connecter et à récupérer votre accès. Stocké chiffré."
      />
      <PasswordField
        label="Mot de passe"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        data-testid="register-password"
        showStrength
        required
      />
      <PasswordField
        label="Confirmer le mot de passe"
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        data-testid="register-confirm"
        required
      />
      {mismatch && <p className="feedback feedback-error">Les deux mots de passe ne sont pas identiques.</p>}
      {error !== null && (
        <p className="feedback feedback-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="btn btn-primary btn-lg btn-block"
        data-testid="register-submit"
        disabled={pending || email.trim() === '' || password.length < MIN_PASSWORD_LENGTH || password !== confirm}
      >
        {pending ? 'Création…' : 'Créer mon compte'}
      </button>
    </form>
  );
}

/** Mode démonstration : données fictives, sans serveur. */
function DemoLink() {
  if (isMockEnabled()) {
    return <p className="muted small">Mode démo actif : n’importe quel mot de passe ouvre la démonstration.</p>;
  }
  return (
    <button
      type="button"
      className="btn btn-link muted"
      onClick={() => {
        setMockEnabled(true);
        window.location.reload();
      }}
    >
      Découvrir avec des données fictives
    </button>
  );
}
