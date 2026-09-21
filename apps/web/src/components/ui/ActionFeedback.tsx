import type { ActionState } from '../../lib/useAction.ts';

/** Ligne de retour d'action : succès lisible ou message d'erreur explicite. */
export function ActionFeedback({ state }: { readonly state: ActionState }) {
  if (state.error !== null) {
    return (
      <p className="feedback feedback-error" role="alert">
        {state.error}
      </p>
    );
  }
  if (state.message !== null) return <p className="feedback feedback-ok">{state.message}</p>;
  return null;
}
