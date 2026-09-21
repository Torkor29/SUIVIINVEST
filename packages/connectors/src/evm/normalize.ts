/**
 * Normalisation on-chain -> `NormalizedTransaction` / `NormalizedPosition`.
 *
 * Règles de conversion (documentées pour être vérifiables) :
 *
 *  - **CRYPTO_TRANSFER** entrant / sortant : un transfert de jeton (ou de natif)
 *    vu depuis l'adresse ; `amount` est signé (entrée > 0, sortie < 0),
 *    `quantity` reste positive ;
 *  - **CRYPTO_SWAP** : quand un même `txHash` porte au moins un transfert
 *    sortant ET un transfert entrant d'un AUTRE jeton, ils sont appariés en un
 *    échange (sinon on produirait deux transferts qui gonflent artificiellement
 *    l'historique). `amount = 0` : un échange ne crée pas de flux de trésorerie
 *    net dans le jeton de référence ;
 *  - **STAKING_REWARD** : un transfert ENTRANT émis par un contrat de staking
 *    explicitement listé (`stakingContracts`). On ne devine jamais : sans liste,
 *    aucun transfert n'est classé en récompense ;
 *  - **FEE** : le gaz d'une transaction émise par l'adresse devient une activité
 *    FEE dédiée (`externalTransactionId = « hash:fee »`), `fees = montant` et
 *    `amount = -frais`. Le gaz n'est PAS ajouté en plus aux transferts du même
 *    hash : pas de double comptage.
 *
 * Les identifiants externes sont des clés STABLES (`txHash:logIndex`,
 * `txHash:native`, `txHash:fee`, `txHash:swap:<logIndex>`) : rejouer une
 * synchronisation ne crée donc jamais de doublon.
 */

import { round, type ActivityType } from '@suiviinvest/core';
import type { NormalizedPosition, NormalizedTransaction } from '../connector.ts';
import type { EvmChain } from './chains.ts';
import type { EvmTokenBalance, EvmTokenTransfer, EvmTransaction } from './providers.ts';

/* ------------------------------------------------------------ unités */

/** Convertit une quantité en base units (hex `0x…` ou décimal) en décimal. */
export function unitsToNumber(raw: string, decimals: number): number | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    // Etherscan renvoie des entiers DÉCIMAUX, le JSON-RPC des valeurs
    // HEXADÉCIMALES : les deux notations sont acceptées par BigInt.
    const value = BigInt(text);
    if (value < 0n) return null;
    return bigintToNumber(value, decimals);
  } catch {
    return null;
  }
}

/** Convertit un BigInt en base units vers un nombre décimal borné à 8 décimales. */
export function bigintToNumber(value: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  return round(Number(whole) + Number(fraction) / Number(base), 8);
}

function isoDayFromTimestamp(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------- contexte */

export interface EvmNormalizeContext {
  /** Identifiant de compte externe (l'adresse publique). */
  readonly accountId: string;
  /** Adresse publique, en minuscules. */
  readonly address: string;
  readonly chain: EvmChain;
  /** Contrats de staking reconnus (adresses minuscules) pour STAKING_REWARD. */
  readonly stakingContracts?: readonly string[];
  readonly rawSourceType?: string;
  /** Signale une ligne ignorée (jamais silencieusement). */
  readonly onSkip?: (reason: string) => void;
}

const DEFAULT_RAW_SOURCE = 'evm.onchain';

function rawOf(ctx: EvmNormalizeContext): string {
  return ctx.rawSourceType ?? DEFAULT_RAW_SOURCE;
}

/* ------------------------------------------------- transferts de jetons */

function transferBase(ctx: EvmNormalizeContext) {
  return {
    externalAccountId: ctx.accountId,
    unitPrice: null,
    fees: 0,
    taxes: 0,
    rawSourceType: rawOf(ctx),
  };
}

function transferToTransaction(
  ctx: EvmNormalizeContext,
  transfer: EvmTokenTransfer,
  direction: 'IN' | 'OUT',
  type: ActivityType,
): NormalizedTransaction | null {
  const date = isoDayFromTimestamp(transfer.timestamp);
  if (date === null) {
    ctx.onSkip?.(`Transfert ${transfer.hash}:${transfer.logIndex} sans horodatage exploitable`);
    return null;
  }
  const symbol = transfer.symbol.toUpperCase();
  const incoming = direction === 'IN';
  const signed = incoming ? transfer.quantity : -transfer.quantity;
  const counterparty = incoming ? transfer.from : transfer.to;
  const description =
    type === 'STAKING_REWARD'
      ? `Récompense de staking ${symbol}`
      : `${incoming ? 'Réception' : 'Envoi'} ${symbol} ${incoming ? 'de' : 'vers'} ${counterparty || '?'}`;

  return {
    ...transferBase(ctx),
    externalTransactionId: `${transfer.hash}:${transfer.logIndex}`,
    externalAssetId: transfer.contractAddress || null,
    date,
    type,
    description,
    quantity: transfer.quantity,
    amount: signed,
    currency: symbol,
  };
}

function swapTransaction(
  ctx: EvmNormalizeContext,
  hash: string,
  outbound: EvmTokenTransfer,
  inbound: EvmTokenTransfer,
): NormalizedTransaction | null {
  const date = isoDayFromTimestamp(inbound.timestamp ?? outbound.timestamp);
  if (date === null) {
    ctx.onSkip?.(`Échange ${hash} sans horodatage exploitable`);
    return null;
  }
  return {
    ...transferBase(ctx),
    externalTransactionId: `${hash}:swap:${outbound.logIndex}`,
    externalAssetId: inbound.contractAddress || null,
    date,
    type: 'CRYPTO_SWAP',
    description: `Échange ${outbound.symbol.toUpperCase()} → ${inbound.symbol.toUpperCase()}`,
    quantity: inbound.quantity,
    // Un échange ne modifie pas la trésorerie nette : montant nul.
    amount: 0,
    currency: inbound.symbol.toUpperCase(),
  };
}

function normalizeTransfers(ctx: EvmNormalizeContext, transfers: readonly EvmTokenTransfer[]): NormalizedTransaction[] {
  const staking = new Set((ctx.stakingContracts ?? []).map((value) => value.toLowerCase()));
  const byHash = new Map<string, EvmTokenTransfer[]>();
  for (const transfer of transfers) {
    const list = byHash.get(transfer.hash) ?? [];
    list.push(transfer);
    byHash.set(transfer.hash, list);
  }

  const results: NormalizedTransaction[] = [];
  for (const [hash, group] of byHash) {
    const outbound = group.filter((transfer) => transfer.from === ctx.address && transfer.to !== ctx.address);
    const inbound = group.filter((transfer) => transfer.to === ctx.address && transfer.from !== ctx.address);

    // Appariement des échanges : un transfert sortant + un transfert entrant de
    // jetons DIFFÉRENTS dans le même hash.
    const pairedOut = new Set<EvmTokenTransfer>();
    const pairedIn = new Set<EvmTokenTransfer>();
    const pairs = Math.min(outbound.length, inbound.length);
    for (let index = 0; index < pairs; index += 1) {
      const out = outbound[index];
      const into = inbound[index];
      if (!out || !into) continue;
      if (out.contractAddress && into.contractAddress && out.contractAddress !== into.contractAddress) {
        const swap = swapTransaction(ctx, hash, out, into);
        if (swap) results.push(swap);
        pairedOut.add(out);
        pairedIn.add(into);
      }
    }

    for (const transfer of group) {
      if (pairedOut.has(transfer) || pairedIn.has(transfer)) continue;
      if (transfer.from === ctx.address && transfer.to === ctx.address) continue; // auto-transfert : sans intérêt
      const incoming = transfer.to === ctx.address;
      if (!incoming && transfer.from !== ctx.address) continue; // hors périmètre de l'adresse
      const isReward = incoming && staking.has(transfer.from);
      const transaction = transferToTransaction(
        ctx,
        transfer,
        incoming ? 'IN' : 'OUT',
        isReward ? 'STAKING_REWARD' : 'CRYPTO_TRANSFER',
      );
      if (transaction) results.push(transaction);
    }
  }
  return results;
}

/* --------------------------------------------------- transactions natives */

function normalizeNativeTransactions(ctx: EvmNormalizeContext, transactions: readonly EvmTransaction[]): NormalizedTransaction[] {
  const results: NormalizedTransaction[] = [];
  for (const transaction of transactions) {
    const date = isoDayFromTimestamp(transaction.timestamp);
    const fromIsSelf = transaction.from === ctx.address;
    const toIsSelf = transaction.to === ctx.address;

    if (date !== null && !transaction.isError) {
      if (toIsSelf && !fromIsSelf && transaction.value > 0) {
        results.push({
          ...transferBase(ctx),
          externalTransactionId: `${transaction.hash}:native`,
          externalAssetId: null,
          date,
          type: 'CRYPTO_TRANSFER',
          description: `Réception ${ctx.chain.nativeSymbol} de ${transaction.from || '?'}`,
          quantity: transaction.value,
          amount: transaction.value,
          currency: ctx.chain.nativeSymbol,
        });
      } else if (fromIsSelf && !toIsSelf && transaction.value > 0) {
        results.push({
          ...transferBase(ctx),
          externalTransactionId: `${transaction.hash}:native`,
          externalAssetId: null,
          date,
          type: 'CRYPTO_TRANSFER',
          description: `Envoi ${ctx.chain.nativeSymbol} vers ${transaction.to ?? '?'}`,
          quantity: transaction.value,
          amount: -transaction.value,
          currency: ctx.chain.nativeSymbol,
        });
      }
    }

    if (fromIsSelf && transaction.feeNative > 0) {
      const feeDate = date ?? isoDayFromTimestamp(transaction.timestamp);
      if (feeDate !== null) {
        results.push({
          ...transferBase(ctx),
          externalTransactionId: `${transaction.hash}:fee`,
          externalAssetId: null,
          date: feeDate,
          type: 'FEE',
          description: `Frais de réseau ${ctx.chain.nativeSymbol}`,
          quantity: null,
          amount: -round(transaction.feeNative, 12),
          currency: ctx.chain.nativeSymbol,
          fees: round(transaction.feeNative, 12),
        });
      }
    }
  }
  return results;
}

export interface NormalizeChainInput {
  readonly transfers?: readonly EvmTokenTransfer[];
  readonly transactions?: readonly EvmTransaction[];
}

/** Normalise l'activité d'UNE chaîne (transferts + transactions natives). */
export function normalizeChainActivity(
  ctx: EvmNormalizeContext,
  input: NormalizeChainInput,
): NormalizedTransaction[] {
  const merged = [
    ...normalizeTransfers(ctx, input.transfers ?? []),
    ...normalizeNativeTransactions(ctx, input.transactions ?? []),
  ];
  // Idempotence : un identifiant externe n'apparaît qu'une fois.
  const seen = new Set<string>();
  const deduped: NormalizedTransaction[] = [];
  for (const transaction of merged) {
    const key = transaction.externalTransactionId ?? `${transaction.date}|${transaction.type}|${transaction.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(transaction);
  }
  return deduped.sort((a, b) => (a.date === b.date ? (a.externalTransactionId ?? '').localeCompare(b.externalTransactionId ?? '') : a.date.localeCompare(b.date)));
}

/* --------------------------------------------------------- positions */

/** Construit les positions d'une chaîne (jetons ERC-20 détenus + solde natif). */
export function positionsFromBalances(
  ctx: EvmNormalizeContext,
  tokens: readonly EvmTokenBalance[],
  nativeQuantity: number | null,
): NormalizedPosition[] {
  const positions: NormalizedPosition[] = [];
  for (const token of tokens) {
    if (!(token.quantity > 0)) continue;
    positions.push({
      externalAccountId: ctx.accountId,
      externalAssetId: token.contractAddress.toLowerCase(),
      isin: null,
      symbol: token.symbol.toUpperCase(),
      name: token.name,
      kind: 'CRYPTO',
      quantity: round(token.quantity, 12),
      unitPrice: null,
      currency: token.symbol.toUpperCase(),
      chain: ctx.chain.id,
      contractAddress: token.contractAddress.toLowerCase(),
      decimals: token.decimals,
      rawSourceType: rawOf(ctx),
    });
  }
  if (nativeQuantity !== null && nativeQuantity > 0) {
    positions.push({
      externalAccountId: ctx.accountId,
      externalAssetId: null,
      isin: null,
      symbol: ctx.chain.nativeSymbol,
      name: `${ctx.chain.name} — solde natif`,
      kind: 'CRYPTO',
      quantity: round(nativeQuantity, 12),
      unitPrice: null,
      currency: ctx.chain.nativeSymbol,
      chain: ctx.chain.id,
      contractAddress: null,
      decimals: ctx.chain.nativeDecimals,
      rawSourceType: rawOf(ctx),
    });
  }
  return positions;
}
