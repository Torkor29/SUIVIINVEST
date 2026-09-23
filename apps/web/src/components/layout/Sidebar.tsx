import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../../nav.ts';
import { ReadOnlyNote } from '../ui/AllocationLegend.tsx';
import { IconLock } from '../ui/Icons.tsx';

export interface SidebarProps {
  readonly open: boolean;
  readonly onNavigate: () => void;
  readonly onLogout: () => void;
  /** Identifiant du compte connecté (`null` = compte historique sans identifiant). */
  readonly username: string | null;
}

/**
 * Navigation principale (fixe sur desktop, tiroir sur mobile).
 *
 * La déconnexion est ici EN PLUS de la barre supérieure : sur un téléphone, la
 * barre supérieure est étroite et le bouton y est facile à manquer. Un bouton
 * libellé en clair, dans le menu, ne laisse aucune place au doute.
 */
export function Sidebar({ open, onNavigate, onLogout, username }: SidebarProps) {
  return (
    <aside className={open ? 'sidebar is-open' : 'sidebar'} aria-label="Navigation principale">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          S
        </span>
        <span className="brand-text">
          <strong>SuiviInvest</strong>
          <small>Patrimoine personnel</small>
        </span>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end === true}
            className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
            onClick={onNavigate}
          >
            <span className="nav-icon">
              <item.icon size={18} />
            </span>
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-account">
          <span className="muted small">Connecté&nbsp;: {username ?? 'compte principal'}</span>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            data-testid="logout"
            onClick={onLogout}
          >
            <IconLock size={16} />
            Se déconnecter
          </button>
        </div>
        <ReadOnlyNote />
      </div>
    </aside>
  );
}