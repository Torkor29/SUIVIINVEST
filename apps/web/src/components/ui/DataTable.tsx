import { useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './AsyncView.tsx';

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly align?: 'left' | 'right';
  /** Fournit une valeur triable (le tri client reste instantané sur ces volumes). */
  readonly sort?: (row: T) => number | string;
  readonly render: (row: T) => ReactNode;
  readonly className?: string;
}

export interface DataTableProps<T> {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly rowKey: (row: T, index: number) => string;
  readonly initialSortKey?: string;
  readonly initialSortDesc?: boolean;
  readonly caption?: string;
  readonly emptyTitle?: string;
  readonly emptyHint?: string;
  readonly maxRows?: number;
}

/** Tableau sobre et triable, pensé pour rester lisible sur mobile (défilement horizontal). */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSortKey,
  initialSortDesc = true,
  caption,
  emptyTitle = 'Aucune ligne',
  emptyHint,
  maxRows = 400,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(initialSortKey ?? null);
  const [desc, setDesc] = useState(initialSortDesc);

  const sorted = useMemo(() => {
    if (sortKey === null) return rows;
    const column = columns.find((candidate) => candidate.key === sortKey);
    if (column?.sort === undefined) return rows;
    const sorter = column.sort;
    return [...rows].sort((a, b) => {
      const left = sorter(a);
      const right = sorter(b);
      if (typeof left === 'number' && typeof right === 'number') return desc ? right - left : left - right;
      const comparison = `${left}`.localeCompare(`${right}`, 'fr');
      return desc ? -comparison : comparison;
    });
  }, [rows, columns, sortKey, desc]);

  if (rows.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;

  const visible = sorted.slice(0, maxRows);

  const toggle = (key: string): void => {
    if (sortKey === key) {
      setDesc(!desc);
      return;
    }
    setSortKey(key);
    setDesc(true);
  };

  return (
    <div className="table-wrap">
      <table className="tbl">
        {caption !== undefined && <caption className="tbl-caption">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={`${column.align === 'right' ? 'is-right' : ''} ${column.className ?? ''}`.trim()}>
                {column.sort === undefined ? (
                  column.header
                ) : (
                  <button type="button" className="tbl-sort" onClick={() => toggle(column.key)}>
                    {column.header}
                    {sortKey === column.key && <span className="tbl-sort-mark">{desc ? '▾' : '▴'}</span>}
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={`${column.align === 'right' ? 'is-right' : ''} ${column.className ?? ''}`.trim()}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-foot">
        {sorted.length > visible.length
          ? `${visible.length} lignes affichées sur ${sorted.length}`
          : `${sorted.length} ligne${sorted.length > 1 ? 's' : ''}`}
      </p>
    </div>
  );
}
