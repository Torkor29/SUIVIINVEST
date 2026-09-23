import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, request } from '../lib/api.ts';
import { PageHeader, Card } from '../components/ui/Card.tsx';
import { Badge } from '../components/ui/Stat.tsx';

interface CompleteResponse {
  readonly bank: string;
  readonly accounts: number;
  readonly validUntil: string | null;
  readonly sync: { status: string; message: string | null; created: number } | null;
}

/**
 * Page de retour après l'accord donné sur le site de la banque
 * (`/connexions/banque?code=…&state=…`). Le code est échangé une seule fois.
 */
export function BankReturnPage() {
  const [result, setResult] = useState<CompleteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const bankError = params.get('error');
    if (bankError !== null) {
      setError(`La banque n’a pas donné accès (${params.get('error_description') ?? bankError}).`);
      return;
    }
    const code = params.get('code');
    const state = params.get('state');
    if (code === null || state === null) {
      setError('Adresse de retour incomplète : recommencez depuis Connexions.');
      return;
    }
    void request<CompleteResponse>('/api/enable-banking/complete', { method: 'POST', json: { code, state } })
      .then((response) => {
        setResult(response);
        // Le code ne sert qu'une fois : on le retire de l'adresse affichée.
        window.history.replaceState(null, '', '/connexions/banque');
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  return (
    <>
      <PageHeader title="Connexion bancaire" subtitle="Retour de votre banque." />
      <Card>
        {error !== null ? (
          <div className="form-stack">
            <Badge tone="danger">Échec</Badge>
            <p className="feedback feedback-error" role="alert">
              {error}
            </p>
            <div>
              <Link className="btn btn-primary" to="/connexions">
                Revenir aux connexions
              </Link>
            </div>
          </div>
        ) : result === null ? (
          <p className="muted" data-testid="bank-return-pending">
            Validation de l’accès et première synchronisation en cours…
          </p>
        ) : (
          <div className="form-stack" data-testid="bank-return-done">
            <Badge tone="ok">Banque reliée</Badge>
            <h2 className="card-title">
              {result.bank} : {result.accounts} compte{result.accounts > 1 ? 's' : ''} relié{result.accounts > 1 ? 's' : ''}
            </h2>
            <p className="muted">
              {result.sync?.status === 'SUCCESS' || result.sync?.status === 'PARTIAL'
                ? `Soldes et opérations récupérés (${result.sync.created} opération(s) ajoutée(s)).`
                : 'La première synchronisation n’a pas abouti : relancez-la depuis Connexions.'}
              {result.validUntil !== null && ` Autorisation valable jusqu’au ${new Date(result.validUntil).toLocaleDateString('fr-FR')}.`}
            </p>
            <div className="card-actions-row">
              <Link className="btn btn-primary" to="/">
                Voir mon patrimoine
              </Link>
              <Link className="btn" to="/connexions">
                Ajouter une autre banque
              </Link>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
