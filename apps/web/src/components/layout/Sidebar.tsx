import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../../nav.ts';
import { ReadOnlyNote } from '../ui/AllocationLegend.tsx';

export interface SidebarProps {
  readonly open: boolean;
  readonly onNavigate: () => void;
}

/** Navigation principale (fixe sur desktop, tiroir sur mobile). */
export function Sidebar({ open, onNavigate }: SidebarProps) {
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
        <ReadOnlyNote />
      </div>
    </aside>
  );
}
