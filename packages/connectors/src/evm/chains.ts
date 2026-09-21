/**
 * Registre des chaînes EVM supportées.
 *
 * Ce fichier est la SEULE source de vérité des points d'entrée par chaîne :
 * aucun provider, aucun connecteur ne code une URL en dur ailleurs. Ajouter un
 * réseau se limite donc à ajouter une entrée ici (plus, si besoin, une entrée
 * dans le mapping du provider concerné).
 *
 * Fiabilité des points d'entrée : ceux ci-dessous reprennent l'audit du
 * 2026-09-21 (voir `docs/connectors/MISSION2_STATE.md`). Les nœuds publics
 * historiquement cités (`eth.llamarpc.com`, `rpc.ankr.com`, `polygon-rpc.com`,
 * `cloudflare-eth.com`) refusent désormais `eth_getBalance` ou exigent une clé :
 * ils ne sont volontairement PAS utilisés comme défaut.
 */

export type EvmExplorerKind = 'etherscan' | 'blockscout' | 'routescan';

export interface EvmChain {
  /** Identifiant stable utilisé en configuration et en base (`ethereum`, `bnb`...). */
  readonly id: string;
  readonly chainId: number;
  /** Nom lisible affiché à l'utilisateur. */
  readonly name: string;
  /** Symbole du jeton natif (ETH, BNB, AVAX...). */
  readonly nativeSymbol: string;
  /** Décimales du natif (18 sur toutes les chaînes visées, explicite par principe). */
  readonly nativeDecimals: number;
  /** Nœud JSON-RPC public, sans clé, vérifié comme répondant. */
  readonly rpcUrl: string;
  /** Explorateur par défaut (lisible par un humain), sans `/api`. */
  readonly explorerUrl: string;
  readonly explorerKind: EvmExplorerKind;
  /** Base de l'API Etherscan-compatible de l'instance Blockscout, ou `null`. */
  readonly blockscoutApi: string | null;
  /** Réseau Alchemy (`eth-mainnet`...), pour construire l'URL JSON-RPC. */
  readonly alchemyNetwork: string;
  /** La chaîne est couverte par l'API Etherscan V2 (avec une clé). */
  readonly etherscanV2Supported: boolean;
  /** La chaîne est couverte par le palier GRATUIT d'Etherscan V2. */
  readonly etherscanFreeTier: boolean;
  /** La chaîne a un point d'entrée Routescan documenté. */
  readonly routescanSupported: boolean;
}

/** Chaîne par défaut quand aucune n'est configurée. */
export const DEFAULT_CHAIN_ID = 'ethereum';

/**
 * Les 7 réseaux demandés. `airdrop`/`zksync`/… s'ajoutent par simple entrée.
 */
export const EVM_CHAINS: Readonly<Record<string, EvmChain>> = {
  ethereum: {
    id: 'ethereum',
    chainId: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorerUrl: 'https://eth.blockscout.com',
    explorerKind: 'blockscout',
    blockscoutApi: 'https://eth.blockscout.com/api',
    alchemyNetwork: 'eth-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: true,
    routescanSupported: true,
  },
  arbitrum: {
    id: 'arbitrum',
    chainId: 42161,
    name: 'Arbitrum One',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbitrum.blockscout.com',
    explorerKind: 'blockscout',
    blockscoutApi: 'https://arbitrum.blockscout.com/api',
    alchemyNetwork: 'arb-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: true,
    routescanSupported: true,
  },
  optimism: {
    id: 'optimism',
    chainId: 10,
    name: 'OP Mainnet',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimism.blockscout.com',
    explorerKind: 'blockscout',
    blockscoutApi: 'https://optimism.blockscout.com/api',
    alchemyNetwork: 'opt-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: false,
    routescanSupported: true,
  },
  base: {
    id: 'base',
    chainId: 8453,
    name: 'Base',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://base.blockscout.com',
    explorerKind: 'blockscout',
    blockscoutApi: 'https://base.blockscout.com/api',
    alchemyNetwork: 'base-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: false,
    routescanSupported: true,
  },
  polygon: {
    id: 'polygon',
    chainId: 137,
    name: 'Polygon',
    nativeSymbol: 'POL',
    nativeDecimals: 18,
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    explorerUrl: 'https://polygon.blockscout.com',
    explorerKind: 'blockscout',
    blockscoutApi: 'https://polygon.blockscout.com/api',
    alchemyNetwork: 'polygon-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: true,
    routescanSupported: true,
  },
  bnb: {
    id: 'bnb',
    chainId: 56,
    name: 'BNB Smart Chain',
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    explorerKind: 'etherscan',
    // Blockscout n'expose pas d'instance publique vérifiée pour BNB.
    blockscoutApi: null,
    alchemyNetwork: 'bnb-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: false,
    routescanSupported: true,
  },
  avalanche: {
    id: 'avalanche',
    chainId: 43114,
    name: 'Avalanche C-Chain',
    nativeSymbol: 'AVAX',
    nativeDecimals: 18,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowtrace.io',
    explorerKind: 'etherscan',
    blockscoutApi: null,
    alchemyNetwork: 'avax-mainnet',
    etherscanV2Supported: true,
    etherscanFreeTier: false,
    routescanSupported: true,
  },
};

/** Chaînes activées par défaut pour un wallet (les 7 demandées). */
export const DEFAULT_CHAIN_IDS: readonly string[] = [
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bnb',
  'avalanche',
];

export function listChains(): readonly EvmChain[] {
  return Object.values(EVM_CHAINS);
}

/** Résolution par identifiant, insensible à la casse ; `null` si inconnue. */
export function getChain(id: string | null | undefined): EvmChain | null {
  if (!id) return null;
  return EVM_CHAINS[id.trim().toLowerCase()] ?? null;
}

/** Résolution par `chainId` numérique ; `null` si la chaîne n'est pas déclarée. */
export function getChainByChainId(chainId: number): EvmChain | null {
  return listChains().find((chain) => chain.chainId === chainId) ?? null;
}

export function isKnownChain(id: string): boolean {
  return getChain(id) !== null;
}

/**
 * Résout une liste d'identifiants de chaînes, en ignorant les inconnues (elles
 * sont signalées par l'appelant, jamais devinées).
 */
export function resolveChains(ids: readonly string[]): { chains: EvmChain[]; unknown: string[] } {
  const chains: EvmChain[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const chain = getChain(id);
    if (chain) {
      if (!chains.some((existing) => existing.id === chain.id)) chains.push(chain);
    } else if (id.trim() !== '') {
      unknown.push(id.trim());
    }
  }
  return { chains, unknown };
}
