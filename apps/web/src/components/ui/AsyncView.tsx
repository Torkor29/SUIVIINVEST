import type { ReactNode } from 'react';
import { SkeletonChart } from './Skeleton.tsx';

export interface EmptyStateProps {
  readonly title: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
}

/** État vide explicite : jamais un écran blanc sans explication. */
export function EmptyState({ title, hint, icon, action }: EmptyStateProps) {
  return (
    <div className="state state-empty">
      {icon !== undefined && <div className="state-icon">{icon}</div>}
      <p className="state-title">{title}</p>
      {hint !== undefined && <p className="state-hint">{hint}</p>}
      {action !== undefined && <div className="state-action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly code?: string;
}

/** État d'erreur lisible, avec relance et code technique discret. */
export function ErrorState({ message, onRetry, code }: ErrorStateProps) {
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">Impossible de charger ces données</p>
      <p className="state-hint">{message}</p>
      <div className="state-action">
        {onRetry !== undefined && (
          <button type="button" className="btn btn-ghost" onClick={onRetry}>
            Réessayer
          </button>
        )}
        {code !== undefined && <span className="state-code">{code}</span>}
      </div>
    </div>
  );
}

export interface AsyncViewProps<T> {
  readonly loading: boolean;
  readonly error: string | null;
  readonly data: T | null;
  readonly onRetry?: () => void;
  readonly errorCode?: string;
  readonly skeleton?: ReactNode;
  readonly empty?: (data: T) => boolean;
  readonly emptyState?: ReactNode;
  readonly children: (data: T) => ReactNode;
}

/**
 * Affiche squelette → erreur → vide → contenu, dans cet ordre de priorité.
 * Factorise l'état de chargement de toutes les pages.
 */
export function AsyncView<T>({
  loading,
  error,
  data,
  onRetry,
  errorCode,
  skeleton,
  empty,
  emptyState,
  children,
}: AsyncViewProps<T>) {
  if (loading && data === null) return <>{skeleton ?? <SkeletonChart />}</>;
  if (error !== null && data === null) {
    return <ErrorState message={error} onRetry={onRetry} code={errorCode} />;
  }
  if (data === null) return <>{skeleton ?? <SkeletonChart />}</>;
  if (empty !== undefined && empty(data)) {
    return <>{emptyState ?? <EmptyState title="Aucune donnée" hint="Rien à afficher pour cette sélection." />}</>;
  }
  return <>{children(data)}</>;
}
