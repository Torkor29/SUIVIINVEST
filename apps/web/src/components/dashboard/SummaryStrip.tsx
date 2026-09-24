import type { NetWorthResponse, PeriodKey } from '@suiviinvest/api-contract';
import { formatEur, formatPercent, formatSignedEur, toneOf } from '../../lib/format.ts';
import { PERIOD_LABELS, seriesVariation } from '../../lib/period.ts';

/**
 * En-tête du tableau de bord : le patrimoine net en très grand, puis la
 * variation sur la période choisie (verte ou rouge), comme dans une appli de
 * courtage.
 */
export function SummaryStrip({ data, period }: { readonly data: NetWorthResponse; readonly period: PeriodKey }) {
  // Variation sur la courbe affichée : ce que l'œil voit, ce que le chiffre dit.
  const variation = seriesVariation(data.series);
  const tone = toneOf(variation.absolute);
  const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '';
  return (
    <section className="hero">
      <div className="hero-main">
        <span className="hero-label">Patrimoine net</span>
        <span className="hero-scope">Tout ce que vous possédez (banque, investissements, crypto, immobilier), dettes déduites.</span>
        <strong className="hero-value" data-testid="networth-total">
          {formatEur(data.total)}
        </strong>
        <span className={`hero-sub tone-${tone}`}>
          {arrow !== '' && <span aria-hidden="true">{arrow}</span>}
          {formatSignedEur(variation.absolute)} ({formatPercent(variation.percent)})
          <span className="hero-sub-period">{PERIOD_LABELS[period].toLowerCase()}</span>
        </span>
      </div>
    </section>
  );
}

/** Variations clés, en pastilles défilantes. */
export function VariationChips({ data }: { readonly data: NetWorthResponse }) {
  const variations = [
    { label: 'Aujourd’hui', ...data.variationToday },
    { label: '1 mois', ...data.variation1M },
    { label: 'Depuis janvier', ...data.variationYtd },
    { label: '1 an', ...data.variation1Y },
    { label: 'Depuis le début', ...data.variationAll },
  ];
  return (
    <dl className="hero-variations">
      {variations.map((variation) => (
        <div key={variation.label} className={`hero-cell tone-${toneOf(variation.absolute)}`}>
          <dt>{variation.label}</dt>
          <dd>{formatSignedEur(variation.absolute, 0)}</dd>
          <dd className="hero-cell-pct">{formatPercent(variation.percent)}</dd>
        </div>
      ))}
    </dl>
  );
}
