import { isMockEnabled } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import { Badge } from '../ui/Stat.tsx';
import { IconLock, IconMenu } from '../ui/Icons.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

export interface TopbarProps {
  readonly onMenu: () => void;
  readonly lastSyncAt: string | null;
  readonly onLogout: () => void;
}

/** Barre supérieure : menu mobile, état de synchronisation, thème et déconnexion. */
export function Topbar({ onMenu, lastSyncAt, onLogout }: TopbarProps) {
  return (
    <header className="topbar">
      <button type="button" className="btn btn-icon topbar-menu" onClick={onMenu} aria-label="Ouvrir le menu">
        <IconMenu size={20} />
      </button>
      <div className="topbar-status">
        {isMockEnabled() && <Badge tone="info" title="Données de démonstration locales">Mode maquette</Badge>}
        <span className="topbar-sync">Dernière synchro&nbsp;: {lastSyncAt === null ? '—' : formatDate(lastSyncAt)}</span>
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        <button type="button" className="btn btn-ghost" onClick={onLogout} aria-label="Se déconnecter">
          <IconLock size={16} />
          <span className="btn-label">Se déconnecter</span>
        </button>
      </div>
    </header>
  );
}
