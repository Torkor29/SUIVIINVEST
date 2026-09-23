import { useState } from 'react';
import { IconKey } from '../ui/Icons.tsx';

/**
 * Affichage UNIQUE d'un code de récupération.
 *
 * Le serveur ne conserve que l'empreinte SHA-256 du code : il est donc
 * impossible de le relire plus tard, ni depuis l'interface, ni depuis la base.
 * Cet écran est la seule occasion de le noter — d'où la case à cocher qui
 * empêche de continuer sans action volontaire.
 */
export function RecoveryCodeNotice({
  code,
  onDone,
  subject = 'votre compte',
}: {
  readonly code: string;
  readonly onDone: () => void;
  readonly subject?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // Presse-papiers indisponible (page servie en HTTP) : le code reste affiché.
      setCopied(false);
    }
  };

  return (
    <>
      <span className="avatar avatar-lg" aria-hidden="true">
        <IconKey size={28} />
      </span>
      <h1 className="login-title">Votre code de secours</h1>
      <p className="login-lead">
        Si vous oubliez le mot de passe de <strong>{subject}</strong>, ce code vous permettra d’en choisir un nouveau.
      </p>
      <code className="code-box" data-testid="recovery-code-issued">
        {code}
      </code>
      <button type="button" className="btn btn-block" onClick={() => void copy()}>
        {copied ? 'Copié ✓' : 'Copier le code'}
      </button>
      <p className="notice notice-warn">
        Il ne sera plus jamais affiché. Rangez-le dans votre gestionnaire de mots de passe ou notez-le sur papier.
      </p>
      <label className="field field-inline">
        <input
          type="checkbox"
          data-testid="recovery-ack"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>J’ai mis ce code en lieu sûr</span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        data-testid="recovery-done"
        disabled={!acknowledged}
        onClick={onDone}
      >
        Continuer
      </button>
    </>
  );
}
