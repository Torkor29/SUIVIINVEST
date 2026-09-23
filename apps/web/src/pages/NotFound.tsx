import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/AsyncView.tsx';

/** Page 404 : reste dans le ton de l'application. */
export function NotFoundPage() {
  return (
    <EmptyState
      title="Page introuvable"
      hint="Ce lien n’existe pas ou plus. Revenez à l’accueil pour retrouver vos chiffres."
      action={
        <Link className="btn btn-primary" to="/">
          Retour à l’accueil
        </Link>
      }
    />
  );
}
