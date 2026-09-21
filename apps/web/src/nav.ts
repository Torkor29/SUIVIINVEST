import type { ReactNode } from 'react';
import { IconAnalytics, IconCash, IconConnections, IconCrypto, IconDashboard, IconIncome, IconInvestments, IconRealEstate, IconSettings, IconTransactions } from './components/ui/Icons.tsx';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: (props: { readonly size?: number }) => ReactNode;
  readonly end?: boolean;
}

/** Les dix sections de navigation de l'application. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Tableau de bord', icon: IconDashboard, end: true },
  { to: '/investissements', label: 'Investissements', icon: IconInvestments },
  { to: '/crypto', label: 'Crypto', icon: IconCrypto },
  { to: '/immobilier', label: 'Immobilier', icon: IconRealEstate },
  { to: '/tresorerie', label: 'Trésorerie & banques', icon: IconCash },
  { to: '/transactions', label: 'Transactions', icon: IconTransactions },
  { to: '/revenus', label: 'Revenus', icon: IconIncome },
  { to: '/analyses', label: 'Analyses', icon: IconAnalytics },
  { to: '/connexions', label: 'Connexions', icon: IconConnections },
  { to: '/parametres', label: 'Paramètres', icon: IconSettings },
];
