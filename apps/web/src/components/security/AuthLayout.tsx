import type { ReactNode } from 'react';
import { IconCheck } from '../ui/Icons.tsx';

/**
 * Mise en page des écrans d'authentification : panneau noir de présentation
 * à gauche (ordinateur), formulaire à droite. Sur téléphone, seul le
 * formulaire reste, en plein écran.
 */
export function AuthLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="login">
      <aside className="login-aside" aria-hidden="true">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-text">
            <strong>SuiviInvest</strong>
            <small>Patrimoine personnel</small>
          </span>
        </div>
        <div className="login-pitch">
          <h2>Tout votre patrimoine. Une seule vue.</h2>
          <p>Bourse, crypto, comptes bancaires et immobilier, réunis et mis à jour automatiquement, sur votre propre serveur.</p>
          <ul className="login-points">
            <li>
              <IconCheck size={18} /> Données chiffrées, hébergées chez vous
            </li>
            <li>
              <IconCheck size={18} /> Lecture seule : aucun ordre, aucun virement
            </li>
            <li>
              <IconCheck size={18} /> Synchronisation de vos banques, courtiers et wallets
            </li>
          </ul>
        </div>
        <svg className="login-art" viewBox="0 0 600 200" preserveAspectRatio="none">
          <defs>
            <linearGradient id="login-art-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2fd07f" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#2fd07f" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d="M0 170 L40 160 L80 164 L120 140 L160 146 L200 120 L240 128 L280 100 L320 108 L360 80 L400 90 L440 62 L480 70 L520 40 L560 48 L600 20 L600 200 L0 200 Z"
            fill="url(#login-art-fill)"
          />
          <path
            d="M0 170 L40 160 L80 164 L120 140 L160 146 L200 120 L240 128 L280 100 L320 108 L360 80 L400 90 L440 62 L480 70 L520 40 L560 48 L600 20"
            fill="none"
            stroke="#2fd07f"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <p className="login-aside-foot">Auto-hébergé · Open source · Sans publicité ni revente de données</p>
      </aside>
      <main className="login-main">{children}</main>
    </div>
  );
}

/** Logo compact affiché au-dessus du formulaire sur téléphone. */
export function AuthBrand() {
  return (
    <div className="brand brand-login">
      <span className="brand-mark" aria-hidden="true">
        S
      </span>
      <span className="brand-text">
        <strong>SuiviInvest</strong>
      </span>
    </div>
  );
}
