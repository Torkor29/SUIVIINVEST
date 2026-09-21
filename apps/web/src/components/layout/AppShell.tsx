import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { healthResponse } from '../../lib/health.ts';
import { Sidebar } from './Sidebar.tsx';
import { Topbar } from './Topbar.tsx';

/** Coquille de l'application : navigation, barre supérieure et contenu. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const { logout } = useAuth();

  useEffect(() => {
    let cancelled = false;
    void healthResponse()
      .then((health) => {
        if (!cancelled) setLastSyncAt(health.lastSyncAt);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={menuOpen ? 'shell menu-open' : 'shell'}>
      <Sidebar open={menuOpen} onNavigate={() => setMenuOpen(false)} />
      {menuOpen && <button type="button" className="scrim" aria-label="Fermer le menu" onClick={() => setMenuOpen(false)} />}
      <div className="shell-main">
        <Topbar onMenu={() => setMenuOpen(true)} lastSyncAt={lastSyncAt} onLogout={() => void logout()} />
        <main className="content">{children}</main>
        <footer className="page-foot">
          <span>SuiviInvest — suivi de patrimoine en lecture seule. Les données restent sur votre serveur.</span>
        </footer>
      </div>
    </div>
  );
}
