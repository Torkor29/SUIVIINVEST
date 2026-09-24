import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CryptoResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { useLivePrices } from '../lib/useLivePrices.ts';
import { formatDate, formatEur, formatNumber, formatQuantity, shortenAddress } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonLines, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile, Badge } from '../components/ui/Stat.tsx';
import { AllocationLegend, ReadOnlyNote, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';
import { AddInvestmentSheet } from '../components/holdings/AddInvestmentSheet.tsx';

/** Compte « Mes cryptos » : cryptos saisies à la main (voir services/holdings.ts). */
const MANUAL_CRYPTO_ADDRESS = 'manual-crypto';

/**
 * Crypto : cryptos saisies à la main (aucun wallet à relier), wallets suivis par
 * leur adresse publique et plateformes en lecture seule.
 */
export function CryptoPage() {
  const state = useAsync<CryptoResponse>((signal) => request<CryptoResponse>('/api/crypto', { signal }), []);
  const [adding, setAdding] = useState(false);
  useLivePrices(state.reload);
  const actions = (
    <span className="card-actions-row">
      <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-crypto-open">
        Ajouter une crypto
      </button>
      <Link className="btn" to="/connexions">
        Relier un wallet
      </Link>
    </span>
  );

  return (
    <>
      <PageHeader
        title="Crypto"
        subtitle="Ajoutez vos cryptos à la main, sans rien relier. Ou suivez un wallet (adresse publique) ou une plateforme (clé en lecture seule)."
        actions={actions}
      />
      {adding && <AddInvestmentSheet scope="crypto" onClose={() => setAdding(false)} onAdded={state.reload} />}
      <AsyncView
        loading={state.loading && state.data === null}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.wallets.length === 0}
        emptyState={
          <EmptyState
            title="Aucune crypto pour l’instant"
            hint="Le plus simple : « Ajouter une crypto », puis la quantité et la date d’achat ; les cours se mettent à jour tout seuls. Wallets (MetaMask, Ledger, Phantom…) et plateformes (Binance, Kraken, Coinbase, Bitpanda) se relient aussi."
          />
        }
        skeleton={
          <>
            <SkeletonTiles count={3} />
            <SkeletonLines lines={5} />
          </>
        }
      >
        {(data) => (
          <>
            <Grid>
              <StatTile label="Total crypto" value={formatEur(data.totalEur)} hint={`${data.wallets.length} portefeuille(s)`} />
              <StatTile label="Chaînes suivies" value={`${data.byChain.length}`} hint={data.byChain.map((slice) => (slice.label === 'unknown' ? 'hors blockchain' : slice.label)).join(' · ')} />
              <StatTile label="Actifs détenus" value={`${data.allocation.length}`} hint="Jetons et stablecoins" />
            </Grid>

            <Grid className="grid-2">
              <Card title="Par jeton" subtitle="Contre-valeur en euros.">
                <div className="split">
                  <DonutChart slices={data.allocation} centerLabel="Crypto" centerValue={formatEur(data.totalEur, 0)} />
                  <AllocationLegend slices={data.allocation} />
                </div>
              </Card>
              <Card title="Par chaîne" subtitle="Répartition par réseau.">
                <DonutChart slices={data.byChain} centerLabel="Chaînes" centerValue={formatEur(data.totalEur, 0)} />
                <AllocationLegend slices={data.byChain} showBars={false} />
              </Card>
            </Grid>

            {data.wallets.map((wallet) => (
              <Card
                key={wallet.accountId}
                title={wallet.name}
                subtitle={
                  wallet.address === MANUAL_CRYPTO_ADDRESS
                    ? 'Saisie manuelle · touchez une crypto pour ses achats'
                    : isPlatform(wallet.address)
                    ? 'Plateforme · lecture seule'
                    : `${shortenAddress(wallet.address)} · ${wallet.chains.length} réseau${wallet.chains.length > 1 ? 'x' : ''}`
                }
                actions={
                  wallet.address === MANUAL_CRYPTO_ADDRESS ? undefined : (
                    <Badge tone="neutral">{wallet.lastSyncedAt === null ? 'Jamais synchronisé' : `Synchro ${formatDate(wallet.lastSyncedAt)}`}</Badge>
                  )
                }
              >
                <div className="wallet-total">
                  <strong>{formatEur(wallet.valueEur)}</strong>
                  {!isPlatform(wallet.address) && wallet.address !== MANUAL_CRYPTO_ADDRESS && <span className="muted small">{shortenAddress(wallet.address, 10, 6)}</span>}
                </div>
                <ul className="asset-list">
                  {wallet.assets.map((asset) => (
                    <li key={`${wallet.accountId}-${asset.symbol}-${asset.chain}`} className="asset-row">
                      <span className="asset-symbol">
                        {wallet.address === MANUAL_CRYPTO_ADDRESS && asset.instrumentId !== null ? (
                          <Link to={`/investissements/${asset.instrumentId}`} className="asset-link">
                            <strong>{asset.symbol}</strong>
                          </Link>
                        ) : (
                          <strong>{asset.symbol}</strong>
                        )}
                        <small className="cell-sub">{asset.name}</small>
                      </span>
                      <Badge tone="neutral">
                        {wallet.address === MANUAL_CRYPTO_ADDRESS ? 'manuel' : asset.chain === 'unknown' ? 'plateforme' : asset.chain}
                      </Badge>
                      <span className="asset-qty">
                        {formatQuantity(asset.quantity)}
                        {asset.contractAddress !== null && <small className="cell-sub">{shortenAddress(asset.contractAddress, 8, 4)}</small>}
                      </span>
                      <span className="asset-price">{asset.price === null ? '—' : formatNumber(asset.price)}</span>
                      <span className="asset-value">{formatEur(asset.valueEur)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}

            <WarningsList warnings={data.warnings} />
            <ReadOnlyNote text="Adresses publiques et clés en lecture seule : SuiviInvest ne peut ni signer, ni déplacer, ni vendre vos cryptos." />
          </>
        )}
      </AsyncView>
    </>
  );
}

/** Compte de plateforme (Binance, Kraken…) : identifiant interne, pas une adresse de wallet. */
function isPlatform(address: string): boolean {
  return /^(binance|kraken|coinbase|bitpanda):/.test(address);
}
