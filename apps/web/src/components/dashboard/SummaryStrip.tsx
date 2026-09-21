import type { NetWorthResponse } from '@suiviinvest/api-contract';
import { formatEur, formatPercent, formatSignedEur, toneOf } from '../../lib/format.ts';

/** Bandeau principal : patrimoine net en très grand, puis les variations clés. */
export function SummaryStrip({ data }: { readonly data: NetWorthResponse }) {
  const variations = [
    { label: "Aujourd’hui", ...data.variationToday },
    { label: '1 mois', ...data.variation1M },
    { label: 'Depuis janvier', ...data.variationYtd },
    { label: '1 an', ...data.variation1Y },
    { label: 'Depuis l’origine', ...data.variationAll },
  ];

  return (
    <section className="hero card">
      <div className="hero-main">
        <span className="hero-label">Patrimoine net</span>
        <strong className="hero-value">{formatEur(data.total)}</strong>
        <span className="hero-sub">
          {formatSignedEur(data.variation1Y.absolute, 0)} sur 1 an ({formatPercent(data.variation1Y.percent)})
        </span>
      </div>
      <dl className="hero-variations">
        {variations.map((variation) => (
          <div key={variation.label} className={`hero-cell tone-${toneOf(variation.absolute)}`}>
            <dt>{variation.label}</dt>
            <dd>{formatSignedEur(variation.absolute, 0)}</dd>
            <dd className="hero-cell-pct">{formatPercent(variation.percent)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
