import { Link } from 'react-router-dom';
import { isMockEnabled } from '../../lib/api.ts';
import { formatRelative } from '../../lib/format.ts';
import { Badge } from '../ui/Stat.tsx';
import { IconLogout } from '../ui/Icons.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { LogoMark } from '../ui/Logo.tsx';

export interface TopbarProps {
  readonly lastSyncAt: string | null;
  readonly onLogout: () => void;
}

/** Barre supérieure : état de synchronisation, thème et déconnexion. */
export function Topbar({ lastSyncAt, onLogout }: TopbarProps) {
  return (
    <header className="topbar">
      <Link to="/" className="brand topbar-brand" aria-label="Accueil">
        <LogoMark size={32} />
      </Link>
      <div className="topbar-status">
        {isMockEnabled() && (
          <Badge tone="info" title="Données fictives, sans serveur">
            Démo
          </Badge>
        )}
        <span className="topbar-sync" title={lastSyncAt ?? undefined}>
          <span className={lastSyncAt === null ? 'sync-dot is-idle' : 'sync-dot'} aria-hidden="true" />
          {lastSyncAt === null ? 'Aucune synchronisation pour l’instant' : `Synchronisé ${formatRelative(lastSyncAt)}`}
        </span>
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        <button type="button" className="btn btn-icon" onClick={onLogout} aria-label="Se déconnecter" title="Se déconnecter">
          <IconLogout size={20} />
        </button>
      </div>
    </header>
  );
}
