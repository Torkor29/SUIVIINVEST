/**
 * Logo SuiviInvest : un carré arrondi (noir en thème clair, blanc en sombre)
 * traversé par une courbe qui monte, terminée par un point vert — le patrimoine
 * qui progresse. Dessiné en SVG, aucune image à charger.
 */
export function LogoMark({ size = 34, className = '' }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg
      className={`logo-mark ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect className="logo-mark-bg" width="32" height="32" rx="9" />
      <path
        className="logo-mark-line"
        d="M7.5 21.5 L12.5 16 L16.5 19 L23 11.5"
        fill="none"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle className="logo-mark-dot" cx="23.2" cy="11.3" r="2.6" />
    </svg>
  );
}

/** Logo complet : pictogramme + nom (« Suivi » léger, « Invest » appuyé). */
export function Logo({ size = 34, subtitle }: { readonly size?: number; readonly subtitle?: string }) {
  return (
    <>
      <LogoMark size={size} />
      <span className="brand-text">
        <strong className="wordmark">
          <span className="wordmark-light">Suivi</span>Invest
        </strong>
        {subtitle !== undefined && <small>{subtitle}</small>}
      </span>
    </>
  );
}
