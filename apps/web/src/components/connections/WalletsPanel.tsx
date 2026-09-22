import { useCallback, useEffect, useState } from 'react';
import type { WalletResyncResponse, WalletStatusDto } from '@suiviinvest/api-contract';
import { ApiRequestError, errorMessage, request } from '../../lib/api.ts';
import { formatEur } from '../../lib/format.ts';
import { Badge, KeyValue } from '../ui/Stat.tsx';
import { Card } from '../ui/Card.tsx';
import { SkeletonLines } from '../ui/Skeleton.tsx';
import {
  describeSyncOutcome,
  lastSyncLabel,
  walletChains,
  walletEndpointNotice,
} from '../../lib/connections.ts';

interface WalletLoad {
  readonly wallets: readonly WalletStatusDto[] | null;
  readonly notice: string | null;
  readonly loading: boolean;
}

/**
 * Vue des portefeuilles EVM (`GET /api/wallets`).
 *
 * L'endpoint est fourni par une autre équipe : s'il n'existe pas encore (404) ou
 * si la session a expiré (401), l'écran l'explique en clair et n'échoue pas —
 * aucune erreur technique brute n'est affichée, rien d'autre n'est cassé.
 */
export function WalletsPanel() {
  const [state, setState] = useState<WalletLoad>({ wallets: null, notice: null, loading: true });
  const [resyncing, setResyncing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const wallets = await request<readonly WalletStatusDto[]>('/api/wallets', signal === undefined ? {} : { signal });
      setState({ wallets, notice: null, loading: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof ApiRequestError) {
        setState({ wallets: null, notice: walletEndpointNotice(error.status, error.code), loading: false });
        return;
      }
      setState({ wallets: null, notice: errorMessage(error), loading: false });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const resync = (wallet: WalletStatusDto): void => {
    setResyncing(wallet.accountId);
    setFeedback(null);
    void (async () => {
      try {
        const response = await request<WalletResyncResponse>(`/api/wallets/${wallet.accountId}/resync`, {
          method: 'POST',
        });
        setFeedback(`${wallet.name} — ${describeSyncOutcome(response.outcome)}`);
        await load();
      } catch (error) {
        if (error instanceof ApiRequestError && (error.status === 404 || error.status === 401)) {
          setFeedback(walletEndpointNotice(error.status, error.code));
        } else {
          setFeedback(errorMessage(error));
        }
      } finally {
        setResyncing(null);
      }
    })();
  };

  if (state.loading && state.wallets === null) {
    return (
      <Card title="Portefeuilles EVM" subtitle="Adresses publiques observées, aucune signature possible.">
        <SkeletonLines lines={3} />
      </Card>
    );
  }

  if (state.wallets === null) {
    return (
      <Card title="Portefeuilles EVM" subtitle="Adresses publiques observées, aucune signature possible.">
        <p className="feedback feedback-warn" role="status" data-testid="wallets-notice">
          {state.notice ?? 'Les portefeuilles ne peuvent pas être affichés pour le moment.'}
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>
          Réessayer
        </button>
      </Card>
    );
  }

  return (
    <Card
      title="Portefeuilles EVM"
      subtitle="Suivi d’adresses publiques : aucune clé privée, aucune signature, aucun transfert."
    >
      <div data-testid="wallets-panel">
        {state.wallets.length === 0 ? (
          <p className="muted small">Aucun portefeuille suivi pour l’instant.</p>
        ) : (
          state.wallets.map((wallet) => (
            <div className="wallet-row" key={wallet.accountId} data-testid={`wallet-${wallet.accountId}`}>
              <div className="wallet-head">
                <span className="cell-main">
                  <strong>{wallet.name}</strong>
                  <small className="cell-sub">{wallet.address}</small>
                </span>
                <Badge tone={wallet.error === null ? 'ok' : 'warn'}>
                  {wallet.error === null ? 'À jour' : 'Erreur'}
                </Badge>
              </div>

              <div className="kv-grid">
                <KeyValue label="Chaînes" value={walletChains(wallet).join(' · ') || '—'} />
                <KeyValue label="Jetons suivis" value={`${wallet.tokenCount}`} />
                <KeyValue label="Valeur" value={formatEur(wallet.valueEur)} />
                <KeyValue label="Dernière synchro" value={lastSyncLabel(wallet.lastSyncedAt)} />
              </div>

              {wallet.chains.length > 0 && (
                <ul className="chain-list">
                  {wallet.chains.map((chain) => (
                    <li key={chain.chain} className="chain-row">
                      <span>
                        <strong>{chain.chain}</strong>
                        <small className="cell-sub">
                          {chain.tokens} jeton(s) · {formatEur(chain.valueEur)} · {lastSyncLabel(chain.lastSyncedAt)}
                        </small>
                      </span>
                      {chain.error !== null && <span className="tone-down small">{chain.error}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {wallet.error !== null && (
                <p className="feedback feedback-error" role="alert">
                  {wallet.error}
                </p>
              )}

              <div className="card-actions-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid={`wallet-resync-${wallet.accountId}`}
                  disabled={resyncing === wallet.accountId}
                  onClick={() => resync(wallet)}
                >
                  {resyncing === wallet.accountId ? 'Resynchronisation…' : 'Resynchroniser'}
                </button>
              </div>
            </div>
          ))
        )}
        {feedback !== null && (
          <p className="feedback feedback-ok" data-testid="wallet-feedback">
            {feedback}
          </p>
        )}
      </div>
    </Card>
  );
}
