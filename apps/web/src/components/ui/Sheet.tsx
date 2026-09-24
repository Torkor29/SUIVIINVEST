import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconClose } from './Icons.tsx';

export interface SheetProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}

/**
 * Fenêtre au premier plan : panneau centré sur ordinateur, feuille remontant du
 * bas sur téléphone. Échap ou un clic sur le fond la ferment.
 *
 * Rendue directement dans `<body>` : une carte (`container-type`) devient le
 * repère des éléments `position: fixed`, la fenêtre y serait sinon enfermée.
 */
export function Sheet({ title, subtitle, onClose, children, testId }: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel} data-testid={testId}>
        <header className="sheet-head">
          <div className="sheet-heading">
            <h2 className="sheet-title">{title}</h2>
            {subtitle !== undefined && <p className="sheet-subtitle">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-icon" aria-label="Fermer" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
