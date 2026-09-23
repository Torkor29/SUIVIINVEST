import { NavLink } from 'react-router-dom';
import { TAB_ITEMS } from '../../nav.ts';
import { IconMore } from '../ui/Icons.tsx';

/** Barre d'onglets du téléphone : quatre raccourcis + « Plus » (menu complet). */
export function TabBar({ onMore, moreOpen }: { readonly onMore: () => void; readonly moreOpen: boolean }) {
  return (
    <nav className="tabbar" aria-label="Onglets">
      {TAB_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end === true}
          className={({ isActive }) => (isActive && !moreOpen ? 'tab is-active' : 'tab')}
          aria-label={item.label}
        >
          <item.icon size={22} />
          <span aria-hidden="true">{item.short ?? item.label}</span>
        </NavLink>
      ))}
      <button type="button" className={moreOpen ? 'tab is-active' : 'tab'} onClick={onMore} aria-label="Plus de sections">
        <IconMore size={22} />
        <span aria-hidden="true">Plus</span>
      </button>
    </nav>
  );
}
