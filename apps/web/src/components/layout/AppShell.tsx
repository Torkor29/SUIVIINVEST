import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { healthResponse } from '../../lib/health.ts';
import { Sidebar } from './Sidebar.tsx';
import { TabBar } from './TabBar.tsx';
import { Topbar } from './Topbar.tsx';

/** Coquille de l'application : navigation, barre supérieure, onglets mobiles et contenu. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const { logout, session } = useAuth();
  const location = useLocation();

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

  // Changement de page : on remonte en haut, comme une appli native.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className={menuOpen ? 'shell menu-open' : 'shell'}>
      <Sidebar
        open={menuOpen}
        onNavigate={() => setMenuOpen(false)}
        onClose={() => setMenuOpen(false)}
        onLogout={() => void logout()}
        username={session?.username ?? null}
        displayName={session?.displayName ?? null}
      />
      {menuOpen && <button type="button" className="scrim" aria-label="Fermer le menu" onClick={() => setMenuOpen(false)} />}
      <div className="shell-main">
        <Topbar lastSyncAt={lastSyncAt} onLogout={() => void logout()} />
        <main className="content">{children}</main>
        <footer className="page-foot">
          <span>SuiviInvest · vos données restent sur votre serveur, chiffrées. Lecture seule : aucun ordre, aucun virement.</span>
        </footer>
      </div>
      <TabBar onMore={() => setMenuOpen((open) => !open)} moreOpen={menuOpen} />
    </div>
  );
}
