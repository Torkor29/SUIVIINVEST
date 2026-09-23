import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DcaPlanDto } from '@suiviinvest/api-contract';
import { request } from '../../lib/api.ts';
import { useAction } from '../../lib/useAction.ts';
import { formatDate, formatEur } from '../../lib/format.ts';
import { describePlan, formatShares } from '../../lib/holdings.ts';
import { ActionFeedback } from '../ui/ActionFeedback.tsx';
import { Badge } from '../ui/Stat.tsx';

/** Investissements programmés : état, prochaine échéance, pause et suppression. */
export function PlansList({
  plans,
  onChanged,
  showAsset = true,
  onEdit,
}: {
  readonly plans: readonly DcaPlanDto[];
  readonly onChanged: () => void;
  readonly showAsset?: boolean;
  readonly onEdit?: (plan: DcaPlanDto) => void;
}) {
  return (
    <ul className="list" data-testid="plans-list">
      {plans.map((plan) => (
        <PlanRow key={plan.id} plan={plan} onChanged={onChanged} showAsset={showAsset} {...(onEdit ? { onEdit } : {})} />
      ))}
    </ul>
  );
}

function PlanRow({
  plan,
  onChanged,
  showAsset,
  onEdit,
}: {
  readonly plan: DcaPlanDto;
  readonly onChanged: () => void;
  readonly showAsset: boolean;
  readonly onEdit?: (plan: DcaPlanDto) => void;
}) {
  const action = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const toggle = (): void => {
    void action.run(async () => {
      await request(`/api/holdings/plans/${plan.id}`, { method: 'PATCH', json: { active: !plan.active } });
      onChanged();
      return plan.active ? 'Mis en pause.' : 'Repris : les échéances manquées sont rattrapées.';
    });
  };
  const remove = (removeOperations: boolean): void => {
    void action.run(async () => {
      await request(`/api/holdings/plans/${plan.id}`, { method: 'DELETE', query: { removeOperations: String(removeOperations) } });
      onChanged();
      return 'Supprimé.';
    });
  };
  return (
    <li className="list-row plan-row" data-testid="plan-row">
      <div className="list-row-main">
        <strong>
          {showAsset ? (
            <Link to={`/investissements/${plan.instrumentId}`}>{plan.assetName}</Link>
          ) : (
            describePlan(plan)
          )}
        </strong>
        <span>
          {showAsset ? `${describePlan(plan)} · ` : ''}
          {plan.executions} achat(s) · {formatEur(plan.investedEur)} investis · {formatShares(plan.quantity)} {plan.assetSymbol ?? ''}
        </span>
        <span>
          {plan.active ? (plan.nextDate ? `Prochain achat : ${formatDate(plan.nextDate, 'long')}` : 'Terminé') : 'En pause'}
          {plan.pending > 0 ? ` · ${plan.pending} en attente du cours` : ''}
        </span>
        <div className="plan-actions">
          <button type="button" className="btn btn-link" disabled={action.pending} onClick={toggle}>
            {plan.active ? 'Mettre en pause' : 'Reprendre'}
          </button>
          {onEdit && (
            <button type="button" className="btn btn-link" onClick={() => onEdit(plan)}>
              Modifier
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn-link tone-down" disabled={action.pending} onClick={() => remove(false)}>
                Arrêter (garder les achats)
              </button>
              <button type="button" className="btn btn-link tone-down" disabled={action.pending} onClick={() => remove(true)}>
                Supprimer aussi les achats
              </button>
              <button type="button" className="btn btn-link" onClick={() => setConfirmDelete(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-link tone-down" onClick={() => setConfirmDelete(true)}>
              Supprimer
            </button>
          )}
        </div>
        <ActionFeedback state={action} />
      </div>
      <div className="list-row-end">
        <Badge tone={plan.active ? 'ok' : 'neutral'}>{plan.active ? 'Actif' : 'En pause'}</Badge>
      </div>
    </li>
  );
}
