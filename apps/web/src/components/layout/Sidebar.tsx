import { NavLink } from 'react-router-dom';
import { NAV_GROUPS, PROFILE } from '../../nav.ts';
import { initialsOf } from '../../lib/initials.ts';
import { IconClose, IconLogout } from '../ui/Icons.tsx';
import { Logo } from '../ui/Logo.tsx';

export interface SidebarProps {
  readonly open: boolean;
  readonly onNavigate: () => void;
  readonly onClose: () => void;
  readonly onLogout: () => void;
  /** Identifiant du compte connecté (`null` = compte historique sans identifiant). */
  readonly username: string | null;
  readonly displayName: string | null;
}

/**
 * Navigation principale : colonne fixe sur ordinateur, panneau coulissant sur
 * mobile (ouvert par l'onglet « Plus »). Le compte et la déconnexion sont
 * toujours en bas, au même endroit.
 */
export function Sidebar({ open, onNavigate, onClose, onLogout, username, displayName }: SidebarProps) {
  const name = displayName ?? username ?? 'Mon compte';
  return (
    <aside className={open ? 'sidebar is-open' : 'sidebar'} aria-label="Navigation principale">
      <div className="brand">
        <Logo />
        <button type="button" className="btn btn-icon sidebar-close" onClick={onClose} aria-label="Fermer le menu">
          <IconClose size={20} />
        </button>
      </div>
      <nav className="nav">
        {NAV_GROUPS.map((group) => (
          <div key={group.label ?? 'principal'} role="group" aria-label={group.label ?? 'Patrimoine'}>
            {group.label !== null && <p className="nav-group-label">{group.label}</p>}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end === true}
                className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
                onClick={onNavigate}
              >
                <span className="nav-icon">
                  <item.icon size={20} />
                </span>
                <span className="nav-label">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-foot">
        <NavLink
          to={PROFILE.to}
          className={({ isActive }) => (isActive ? 'account-chip is-active' : 'account-chip')}
          onClick={onNavigate}
          aria-label={`Mon profil (${name})`}
        >
          <span className="avatar" aria-hidden="true">
            {initialsOf(name)}
          </span>
          <span className="account-chip-text">
            <strong>{name}</strong>
            <span>{username === null ? 'Compte principal' : `@${username}`}</span>
          </span>
        </NavLink>
        <button type="button" className="btn btn-ghost btn-block" data-testid="logout" onClick={onLogout}>
          <IconLogout size={18} />
          Se déconnecter
        </button>
      </div>
    </aside>
  );
}
