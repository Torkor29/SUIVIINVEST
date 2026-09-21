/** Portefeuilles crypto de la maquette (MetaMask, plusieurs chaînes). */
import type { CryptoAssetDto, CryptoWalletDto } from '@suiviinvest/api-contract';
import { round2 } from './random.ts';

interface RawAsset {
  readonly chain: string;
  readonly symbol: string;
  readonly name: string;
  readonly contractAddress: string | null;
  readonly quantity: number;
  readonly price: number;
  readonly isNative: boolean;
}

export const CRYPTO_PRICES: Readonly<Record<string, number>> = {
  ETH: 3120.4,
  BTC: 58400.2,
  SOL: 142.35,
  USDC: 1,
  USDT: 1,
  ARB: 0.72,
  POL: 0.42,
  LINK: 14.8,
};

export const RAW_WALLETS: readonly {
  readonly accountId: string;
  readonly name: string;
  readonly address: string;
  readonly lastSyncedAt: string;
  readonly assets: readonly RawAsset[];
}[] = [
  {
    accountId: 'acc-mm-main',
    name: 'MetaMask — portefeuille principal',
    address: '0x7a4F1c9b2D8e5A6f03B1C4d9E7a2F5b8C1d3E6a9',
    lastSyncedAt: '2026-09-21T06:12:00Z',
    assets: [
      { chain: 'ethereum', symbol: 'ETH', name: 'Ethereum', contractAddress: null, quantity: 1.8424, price: 3120.4, isNative: true },
      { chain: 'arbitrum', symbol: 'ARB', name: 'Arbitrum', contractAddress: '0x912ce59144191c1204e64559fe8253a0e49e6548', quantity: 320, price: 0.72, isNative: false },
      { chain: 'polygon', symbol: 'POL', name: 'Polygon Ecosystem Token', contractAddress: '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6', quantity: 900, price: 0.42, isNative: false },
      { chain: 'ethereum', symbol: 'LINK', name: 'Chainlink', contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca', quantity: 42.5, price: 14.8, isNative: false },
    ],
  },
  {
    accountId: 'acc-mm-cold',
    name: 'MetaMask — réserve stablecoins',
    address: '0x1B2c3D4e5F6a7B8c9D0e1F2a3B4c5D6e7F8a9B0c',
    lastSyncedAt: '2026-09-20T21:40:00Z',
    assets: [
      { chain: 'ethereum', symbol: 'BTC', name: 'Wrapped Bitcoin (WBTC)', contractAddress: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', quantity: 0.0412, price: 58400.2, isNative: false },
      { chain: 'solana', symbol: 'SOL', name: 'Solana', contractAddress: null, quantity: 12.5, price: 142.35, isNative: true },
      { chain: 'polygon', symbol: 'USDC', name: 'USD Coin', contractAddress: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', quantity: 1250, price: 1, isNative: false },
    ],
  },
];

export function buildWallets(): CryptoWalletDto[] {
  return RAW_WALLETS.map((wallet) => {
    const assets: CryptoAssetDto[] = wallet.assets.map((asset) => ({
      chain: asset.chain,
      symbol: asset.symbol,
      name: asset.name,
      contractAddress: asset.contractAddress,
      quantity: asset.quantity,
      price: asset.price,
      currency: 'EUR',
      valueEur: round2(asset.quantity * asset.price),
      isNative: asset.isNative,
    }));
    return {
      accountId: wallet.accountId,
      name: wallet.name,
      address: wallet.address,
      chains: [...new Set(assets.map((asset) => asset.chain))],
      valueEur: round2(assets.reduce((sum, asset) => sum + asset.valueEur, 0)),
      assets,
      lastSyncedAt: wallet.lastSyncedAt,
    };
  });
}

export function cryptoTotalEur(): number {
  return round2(buildWallets().reduce((sum, wallet) => sum + wallet.valueEur, 0));
}
