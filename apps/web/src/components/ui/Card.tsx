import type { ReactNode } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly padded?: boolean;
}

/** Conteneur principal de l'interface : titre, actions et contenu. */
export function Card({ title, subtitle, actions, children, className = '', padded = true }: CardProps) {
  return (
    <section className={`card ${padded ? 'card-padded' : ''} ${className}`.trim()}>
      {(title !== undefined || actions !== undefined) && (
        <header className="card-head">
          <div>
            {title !== undefined && <h2 className="card-title">{title}</h2>}
            {subtitle !== undefined && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export interface GridProps {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Grille responsive de tuiles. */
export function Grid({ children, className = '' }: GridProps) {
  return <div className={`grid ${className}`.trim()}>{children}</div>;
}

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {subtitle !== undefined && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="page-actions">{actions}</div>}
    </header>
  );
}
