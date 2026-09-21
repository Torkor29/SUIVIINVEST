import { useTheme } from '../../lib/useTheme.ts';
import { IconMoon, IconSun } from '../ui/Icons.tsx';

/** Bascule clair/sombre : le choix est mémorisé et appliqué immédiatement. */
export function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      type="button"
      className="btn btn-icon"
      onClick={toggle}
      title={resolved === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre'}
      aria-label={resolved === 'dark' ? 'Activer le thème clair' : 'Activer le thème sombre'}
    >
      {resolved === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
    </button>
  );
}
