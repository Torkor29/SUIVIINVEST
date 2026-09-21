/** Squelettes de chargement : ils gardent la mise en page stable pendant le fetch. */
export function Skeleton({ height = 16, width = '100%', radius = 8 }: { readonly height?: number; readonly width?: number | string; readonly radius?: number }) {
  return <span className="skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}

export function SkeletonLines({ lines = 3 }: { readonly lines?: number }) {
  return (
    <div className="skeleton-block" role="status" aria-label="Chargement">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? '62%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonTiles({ count = 4 }: { readonly count?: number }) {
  return (
    <div className="grid" role="status" aria-label="Chargement">
      {Array.from({ length: count }, (_, index) => (
        <div className="card tile" key={index}>
          <Skeleton width={90} height={12} />
          <Skeleton width={140} height={28} />
          <Skeleton width={70} height={12} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ height = 240 }: { readonly height?: number }) {
  return (
    <div className="skeleton-chart" role="status" aria-label="Chargement du graphique">
      <Skeleton height={height} radius={14} />
    </div>
  );
}

export function SkeletonTable({ rows = 6 }: { readonly rows?: number }) {
  return (
    <div className="skeleton-table" role="status" aria-label="Chargement du tableau">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={18} />
      ))}
    </div>
  );
}
