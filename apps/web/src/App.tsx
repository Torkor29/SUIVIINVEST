import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth.tsx';
import { AppShell } from './components/layout/AppShell.tsx';
import { SkeletonLines } from './components/ui/Skeleton.tsx';
import { LoginPage } from './pages/Login.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { InvestmentsPage } from './pages/Investments.tsx';
import { CryptoPage } from './pages/Crypto.tsx';
import { RealEstatePage } from './pages/RealEstate.tsx';
import { CashPage } from './pages/Cash.tsx';
import { TransactionsPage } from './pages/Transactions.tsx';
import { IncomePage } from './pages/Income.tsx';
import { AnalyticsPage } from './pages/Analytics.tsx';
import { ConnectionsPage } from './pages/Connections.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { NotFoundPage } from './pages/NotFound.tsx';

/** Routes de l'application (dix sections + connexion). */
function RoutesTree() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/investissements" element={<InvestmentsPage />} />
        <Route path="/crypto" element={<CryptoPage />} />
        <Route path="/immobilier" element={<RealEstatePage />} />
        <Route path="/tresorerie" element={<CashPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/revenus" element={<IncomePage />} />
        <Route path="/analyses" element={<AnalyticsPage />} />
        <Route path="/connexions" element={<ConnectionsPage />} />
        <Route path="/parametres" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}

/** Porte d'entrée : session authentifiée requise pour afficher les sections. */
function Gate() {
  const { session, loading, error } = useAuth();

  if (loading && session === null) {
    return (
      <div className="boot">
        <SkeletonLines lines={4} />
        <p className="muted small">Connexion à l’API SuiviInvest…</p>
        {error !== null && <p className="feedback feedback-error">{error}</p>}
      </div>
    );
  }
  if (session === null || !session.authenticated) return <LoginPage />;
  return <RoutesTree />;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </AuthProvider>
  );
}
