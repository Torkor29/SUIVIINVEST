import { useState } from 'react';

/**
 * Affichage UNIQUE d'un code de récupération.
 *
 * Le serveur ne conserve que l'empreinte SHA-256 du code : il est donc
 * impossible de le relire plus tard, ni depuis l'interface, ni depuis la base.
 * Cet écran est la seule occasion de le noter — d'où le bouton explicite qui
 * empêche de continuer sans avoir fait une action volontaire.
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
      // Presse-papiers indisponible (contexte non sécurisé) : le code reste
      // affiché, l'utilisateur le note à la main.
      setCopied(false);
    }
  };

  return (
    <>
      <h1 className="login-title">Notez ce code de récupération</h1>
      <p className="muted small">
        Il permet de reprendre la main sur <strong>{subject}</strong> si le mot de passe est perdu,
        sans e-mail et sans accès au serveur.
      </p>
      <p className="feedback feedback-ok" data-testid="recovery-code-issued">
        <code style={{ fontSize: '1.05rem', letterSpacing: '0.08em' }}>{code}</code>
      </p>
      <p className="muted small">
        ⚠️ Il ne sera <strong>plus jamais affiché</strong> : le serveur n’en garde qu’une empreinte
        irréversible. Rangez-le dans votre gestionnaire de mots de passe, à côté du mot de passe.
      </p>
      <button type="button" className="btn btn-ghost btn-block" onClick={() => void copy()}>
        {copied ? 'Code copié ✓' : 'Copier le code'}
      </button>
      <label className="field field-inline">
        <input
          type="checkbox"
          data-testid="recovery-ack"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>J’ai noté mon code de récupération</span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-block"
        data-testid="recovery-done"
        disabled={!acknowledged}
        onClick={onDone}
      >
        Continuer
      </button>
    </>
  );
}