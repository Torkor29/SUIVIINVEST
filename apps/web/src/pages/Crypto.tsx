import type { CryptoResponse } from '@suiviinvest/api-contract';
import { request } from '../lib/api.ts';
import { useAsync } from '../lib/useAsync.ts';
import { formatDate, formatEur, formatNumber, formatQuantity, shortenAddress } from '../lib/format.ts';
import { PageHeader, Card, Grid } from '../components/ui/Card.tsx';
import { AsyncView, EmptyState } from '../components/ui/AsyncView.tsx';
import { SkeletonLines, SkeletonTiles } from '../components/ui/Skeleton.tsx';
import { StatTile, Badge } from '../components/ui/Stat.tsx';
import { AllocationLegend, ReadOnlyNote, WarningsList } from '../components/ui/AllocationLegend.tsx';
import { DonutChart } from '../components/charts/DonutChart.tsx';

/** Crypto : portefeuilles MetaMask (lecture seule), actifs par chaîne. */
export function CryptoPage() {
  const state = useAsync<CryptoResponse>((signal) => request<CryptoResponse>('/api/crypto', { signal }), []);

  return (
    <>
      <PageHeader
        title="Crypto"
        subtitle="Vos wallets (adresse publique) et plateformes (clé en lecture seule). Aucune clé privée de wallet n’est demandée."
        actions={<Badge tone="info">Lecture seule</Badge>}
      />
      <AsyncView
        loading={state.loading}
        error={state.error}
        data={state.data}
        onRetry={state.reload}
        empty={(data) => data.wallets.length === 0}
        emptyState={<EmptyState title="Aucun portefeuille" hint="Ajoutez un wallet (MetaMask, Ledger, Phantom…) ou une plateforme (Binance, Kraken, Coinbase, Bitpanda) dans Connexions." />}
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
                  isPlatform(wallet.address)
                    ? 'Plateforme · lecture seule'
                    : `${shortenAddress(wallet.address)} · ${wallet.chains.length} réseau${wallet.chains.length > 1 ? 'x' : ''}`
                }
                actions={<Badge tone="neutral">{wallet.lastSyncedAt === null ? 'Jamais synchronisé' : `Synchro ${formatDate(wallet.lastSyncedAt)}`}</Badge>}
              >
                <div className="wallet-total">
                  <strong>{formatEur(wallet.valueEur)}</strong>
                  {!isPlatform(wallet.address) && <span className="muted small">{shortenAddress(wallet.address, 10, 6)}</span>}
                </div>
                <ul className="asset-list">
                  {wallet.assets.map((asset) => (
                    <li key={`${wallet.accountId}-${asset.symbol}-${asset.chain}`} className="asset-row">
                      <span className="asset-symbol">
                        <strong>{asset.symbol}</strong>
                        <small className="cell-sub">{asset.name}</small>
                      </span>
                      <Badge tone="neutral">{asset.chain === 'unknown' ? 'plateforme' : asset.chain}</Badge>
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
