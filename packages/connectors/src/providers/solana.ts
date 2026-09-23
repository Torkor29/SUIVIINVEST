import { ConnectorError, redact, type ConnectorContext, type NormalizedAccount } from '../connector.ts';
import { createBalanceConnector, type Holding } from './crypto-common.ts';

/**
 * Wallet Solana (Phantom, Solflare, Backpack, Ledger…), en lecture seule par
 * adresse publique : SOL natif + jetons SPL (programmes Token et Token-2022).
 * Nœud RPC public par défaut ; un autre nœud (Helius, QuickNode…) peut être
 * indiqué dans la configuration `rpc_url`.
 */

const PROVIDER_ID = 'solana';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Jetons courants : symbole lisible et cotation directe. */
const KNOWN_MINTS: Readonly<Record<string, { symbol: string; name: string }>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', name: 'Jupiter' },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', name: 'Bonk' },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: 'WIF', name: 'dogwifhat' },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: 'PYTH', name: 'Pyth Network' },
  So11111111111111111111111111111111111111112: { symbol: 'SOL', name: 'Wrapped SOL' },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'MSOL', name: 'Marinade staked SOL' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JITOSOL', name: 'Jito staked SOL' },
};

interface RpcResponse<T> {
  readonly result?: T;
  readonly error?: { code: number; message: string };
}

interface ParsedTokenAccount {
  readonly account: {
    readonly data: {
      readonly parsed?: {
        readonly info?: {
          readonly mint: string;
          readonly tokenAmount: { readonly uiAmount: number | null; readonly uiAmountString?: string; readonly decimals: number };
        };
      };
    };
  };
}

function requireAddress(ctx: ConnectorContext): string {
  const address = (ctx.config.address ?? '').trim();
  if (!ADDRESS_PATTERN.test(address)) {
    throw new ConnectorError(PROVIDER_ID, 'AUTH_REQUIRED', 'Adresse Solana publique manquante ou invalide.');
  }
  return address;
}

async function rpc<T>(ctx: ConnectorContext, method: string, params: unknown[]): Promise<T> {
  const url = (ctx.config.rpc_url ?? '').trim() || DEFAULT_RPC;
  const response = await ctx.http.json<RpcResponse<T>>(url, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (response.error) {
    throw new ConnectorError(PROVIDER_ID, 'PROVIDER_BROKEN', `RPC Solana (${method}) : ${redact(response.error.message)}`);
  }
  if (response.result === undefined) {
    throw new ConnectorError(PROVIDER_ID, 'PROVIDER_BROKEN', `RPC Solana (${method}) : réponse vide.`);
  }
  return response.result;
}

/** Cotations EUR des jetons SPL non courants, par adresse de mint (CoinGecko public). */
async function splPricesEur(ctx: ConnectorContext, mints: readonly string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  if (mints.length === 0) return prices;
  try {
    const response = await ctx.http.json<Record<string, { eur?: number }>>(
      `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${mints.slice(0, 50).join(',')}&vs_currencies=eur`,
    );
    for (const [mint, value] of Object.entries(response)) {
      if (typeof value.eur === 'number' && value.eur > 0) prices.set(mint, value.eur);
    }
  } catch (error) {
    ctx.logger.warn(`Cotations des jetons Solana indisponibles : ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  return prices;
}

export const solanaConnector = createBalanceConnector({
  id: PROVIDER_ID,
  displayName: 'Solana',
  requiredConfig: ['address'],
  requiredSecrets: [],
  rawSourceType: 'solana.wallet',

  async account(ctx): Promise<NormalizedAccount> {
    const address = requireAddress(ctx);
    return {
      externalAccountId: address,
      name: `Solana ${address.slice(0, 4)}…${address.slice(-4)}`,
      type: 'CRYPTO',
      currency: 'EUR',
      rawSourceType: 'solana.wallet',
      balance: null,
      isActive: true,
    };
  },

  async holdings(ctx): Promise<readonly Holding[]> {
    const address = requireAddress(ctx);
    const balance = await rpc<{ value: number }>(ctx, 'getBalance', [address]);
    const holdings: Holding[] = [{ symbol: 'SOL', name: 'Solana', quantity: balance.value / 1e9, chain: 'solana' }];

    const unknown: { mint: string; quantity: number; decimals: number }[] = [];
    for (const programId of TOKEN_PROGRAMS) {
      let accounts: { value: readonly ParsedTokenAccount[] };
      try {
        accounts = await rpc(ctx, 'getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed' }]);
      } catch (error) {
        ctx.logger.warn(`Jetons Solana non lus (${programId.slice(0, 6)}…) : ${redact(error instanceof Error ? error.message : String(error))}`);
        continue;
      }
      for (const entry of accounts.value) {
        const info = entry.account.data.parsed?.info;
        if (!info) continue;
        const quantity = Number(info.tokenAmount.uiAmountString ?? info.tokenAmount.uiAmount ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        const known = KNOWN_MINTS[info.mint];
        if (known) {
          holdings.push({ symbol: known.symbol, name: known.name, quantity, chain: 'solana', decimals: info.tokenAmount.decimals });
        } else {
          unknown.push({ mint: info.mint, quantity, decimals: info.tokenAmount.decimals });
        }
      }
    }

    const prices = await splPricesEur(ctx, unknown.map((token) => token.mint));
    for (const token of unknown) {
      holdings.push({
        symbol: `SPL-${token.mint.slice(0, 4)}`,
        name: `Jeton Solana ${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`,
        quantity: token.quantity,
        chain: 'solana',
        contractAddress: token.mint,
        decimals: token.decimals,
        priceEur: prices.get(token.mint) ?? null,
      });
    }
    return holdings;
  },
});
