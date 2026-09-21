import type { PropertyDto } from '@suiviinvest/api-contract';
import { formatDate, formatEur, formatPercent, formatSignedEur, toneOf } from '../../lib/format.ts';
import { Card } from '../ui/Card.tsx';
import { KeyValue, Badge } from '../ui/Stat.tsx';

/** Fiche d'un bien : acquisition, financement, rendements et cash-flow. */
export function PropertyCard({ property }: { readonly property: PropertyDto }) {
  const { metrics } = property;
  return (
    <Card
      title={property.name}
      subtitle={property.address ?? 'Adresse non renseignée'}
      actions={
        <>
          <Badge tone="neutral">{property.kind.toLowerCase()}</Badge>
          {property.surfaceM2 !== null && <Badge tone="neutral">{property.surfaceM2} m²</Badge>}
        </>
      }
    >
      <div className="kv-grid">
        <KeyValue label="Acquisition" value={`${formatDate(property.purchaseDate)} · ${formatEur(property.purchasePrice, 0)}`} />
        <KeyValue label="Coût total" value={formatEur(metrics.totalCost, 0)} />
        <KeyValue label="Valeur estimée" value={formatEur(property.currentValue, 0)} />
        <KeyValue label="Plus-value latente" value={formatSignedEur(metrics.unrealizedGain, 0)} tone={toneOf(metrics.unrealizedGain)} />
        <KeyValue label="Fonds propres" value={formatEur(metrics.equity, 0)} />
        <KeyValue label="Capital restant dû" value={formatEur(metrics.loanBalance, 0)} />
        <KeyValue label="Rendement brut" value={formatPercent(metrics.grossYield, { sign: false })} />
        <KeyValue label="Rendement net" value={formatPercent(metrics.netYield, { sign: false })} />
        <KeyValue label="Rendement sur fonds propres" value={formatPercent(metrics.yieldOnEquity, { sign: false })} />
        <KeyValue label="Cash-flow mensuel" value={formatSignedEur(metrics.monthlyCashFlow, 0)} tone={toneOf(metrics.monthlyCashFlow)} />
        <KeyValue
          label="Après échéance de crédit"
          value={formatSignedEur(metrics.monthlyCashFlowAfterLoan, 0)}
          tone={toneOf(metrics.monthlyCashFlowAfterLoan)}
        />
        <KeyValue label="Taux d’occupation" value={formatPercent(metrics.occupancyRate * 100, { sign: false, digits: 0 })} />
      </div>

      {property.loan !== null && (
        <div className="loan">
          <h3 className="loan-title">Crédit</h3>
          <div className="kv-grid">
            <KeyValue label="Mensualité" value={`${formatEur(property.loan.monthlyPayment)} + ${formatEur(property.loan.insuranceMonthly)} d’assurance`} />
            <KeyValue label="Taux annuel" value={formatPercent(property.loan.annualRate * 100, { sign: false })} />
            <KeyValue label="Durée" value={`${property.loan.months} mois`} />
            <KeyValue label="Début / fin" value={`${formatDate(property.loan.startDate, 'short')} → ${formatDate(property.loan.endDate, 'short')}`} />
            <KeyValue label="Intérêts payés" value={formatEur(property.loan.interestPaid, 0)} />
            <KeyValue label="Capital remboursé" value={formatEur(property.loan.principalRepaid, 0)} />
          </div>
        </div>
      )}

      {property.notes !== null && <p className="muted small">{property.notes}</p>}
    </Card>
  );
}
