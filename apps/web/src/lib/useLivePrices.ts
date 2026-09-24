import { useEffect, useRef, useState } from 'react';
import { request } from './api.ts';

/** Intervalle entre deux relevés en direct, tant que la page est visible. */
export const LIVE_INTERVAL_MS = 60_000;

/**
 * Cours en direct : tant que la page est affichée, demande chaque minute au
 * serveur les dernières cotations des actifs détenus, puis appelle `onUpdate`
 * quand un cours a bougé (la page se recharge sans écran de chargement).
 * En arrière-plan (onglet caché, téléphone verrouillé), rien n'est demandé ;
 * au retour, un relevé part aussitôt.
 */
export function useLivePrices(onUpdate: () => void): { readonly at: string | null } {
  const [at, setAt] = useState<string | null>(null);
  const callback = useRef(onUpdate);
  callback.current = onUpdate;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const result = await request<{ updated: number; at: string | null }>('/api/holdings/live');
        if (stopped) return;
        setAt(result.at);
        if (result.updated > 0) callback.current();
      } catch {
        // Réseau coupé : on réessaie au prochain passage.
      }
      if (!stopped) timer = setTimeout(() => void tick(), LIVE_INTERVAL_MS);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { at };
}
