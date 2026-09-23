import type { ReactNode } from 'react';
import {
  IconAnalytics,
  IconCash,
  IconConnections,
  IconCrypto,
  IconHome,
  IconIncome,
  IconInvestments,
  IconRealEstate,
  IconSettings,
  IconTransactions,
  IconUser,
} from './components/ui/Icons.tsx';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Libellé court de la barre d'onglets mobile. */
  readonly short?: string;
  readonly icon: (props: { readonly size?: number }) => ReactNode;
  readonly end?: boolean;
}

export interface NavGroup {
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

export const HOME: NavItem = { to: '/', label: 'Accueil', short: 'Accueil', icon: IconHome, end: true };
export const INVESTMENTS: NavItem = { to: '/investissements', label: 'Investissements', short: 'Portefeuille', icon: IconInvestments };
export const CRYPTO: NavItem = { to: '/crypto', label: 'Crypto', short: 'Crypto', icon: IconCrypto };
export const REAL_ESTATE: NavItem = { to: '/immobilier', label: 'Immobilier', icon: IconRealEstate };
export const CASH: NavItem = { to: '/tresorerie', label: 'Banque', icon: IconCash };
export const ACTIVITY: NavItem = { to: '/transactions', label: 'Activité', short: 'Activité', icon: IconTransactions };
export const INCOME: NavItem = { to: '/revenus', label: 'Revenus', icon: IconIncome };
export const ANALYTICS: NavItem = { to: '/analyses', label: 'Analyses', icon: IconAnalytics };
export const CONNECTIONS: NavItem = { to: '/connexions', label: 'Connexions', icon: IconConnections };
export const PROFILE: NavItem = { to: '/profil', label: 'Profil', icon: IconUser };
export const SETTINGS: NavItem = { to: '/parametres', label: 'Paramètres', icon: IconSettings };

/** Navigation complète, regroupée comme dans une appli bancaire. */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: null, items: [HOME, INVESTMENTS, CRYPTO, REAL_ESTATE, CASH] },
  { label: 'Suivi', items: [ACTIVITY, INCOME, ANALYTICS] },
  { label: 'Compte', items: [CONNECTIONS, PROFILE, SETTINGS] },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Onglets de la barre mobile (le dernier, « Plus », ouvre le menu complet). */
export const TAB_ITEMS: readonly NavItem[] = [HOME, INVESTMENTS, CRYPTO, ACTIVITY];
