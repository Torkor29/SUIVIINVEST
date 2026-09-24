import { formatPointDate } from '../../lib/format.ts';

/** « ● En direct · 14:32 » : cours relevés automatiquement chaque minute. */
export function LiveBadge({ at }: { readonly at: string | null }) {
  return (
    <span className="live-badge" data-testid="live-badge">
      <span className="live-dot" aria-hidden="true" />
      En direct{at ? ` · ${formatPointDate(at)}` : ''}
    </span>
  );
}
