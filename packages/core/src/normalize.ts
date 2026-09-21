import { normalizeDate } from './dedup.ts';
import { round } from './money.ts';
import type { ActivityType } from './types.ts';

/**
 * Normalisation des données brutes de fournisseurs.
 *
 * Ce module contient les primitives partagées par TOUS les connecteurs. Il ne
 * connaît aucun fournisseur en particulier : chaque connecteur l'appelle avec ses
 * propres libellés.
 */

/* --------------------------------------------------------------- nombres */

/**
 * Analyse un nombre au format « humain », quel que soit le séparateur décimal.
 *
 * Gère : `1 234,56` (FR), `1,234.56` (US), `1.234,56` (DE), `(123,45)` (négatif
 * comptable), suffixe/prefixe de devise, espaces insécables, `%` et `€`.
 * Retourne `null` si la valeur n'est pas un nombre exploitable — on ne remplace
 * JAMAIS par 0 une valeur illisible, cela masquerait une erreur d'import.
 */
export function parseAmount(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? round(raw) : null;

  let text = raw.replace(/\u00a0|\u202f|\s/g, '').trim();
  if (text === '' || text === '-') return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[€$£%]|[A-Za-z]{2,3}$/g, '');
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (text === '') return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Le dernier séparateur rencontré est le décimal.
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // Virgule seule : décimale si 1 ou 2 chiffres après, sinon séparateur de milliers.
    const decimals = text.length - lastComma - 1;
    text = decimals === 1 || decimals === 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return round(negative ? -value : value);
}

/** Parse une quantité (toujours positive ; le sens est porté par le type d'activité). */
export function parseQuantity(raw: string | number | null | undefined): number | null {
  const value = parseAmount(raw);
  return value === null ? null : round(Math.abs(value), 8);
}

/** Devise ISO à partir d'un texte libre (`€`, `EUR`, `euro`, `$`, `USD`...). */
export function parseCurrency(raw: string | null | undefined, fallback: string | null = null): string | null {
  if (!raw) return fallback;
  const text = raw.trim().toUpperCase();
  if (text === '') return fallback;
  const symbolMap: Record<string, string> = {
    '€': 'EUR',
    EURO: 'EUR',
    EUROS: 'EUR',
    $: 'USD',
    USD: 'USD',
    DOLLAR: 'USD',
    '£': 'GBP',
    GBP: 'GBP',
    CHF: 'CHF',
    '¥': 'JPY',
    JPY: 'JPY',
    SEK: 'SEK',
    NOK: 'NOK',
    DKK: 'DKK',
    PLN: 'PLN',
    CZK: 'CZK',
    HUF: 'HUF',
    CAD: 'CAD',
    AUD: 'AUD',
  };
  for (const [key, value] of Object.entries(symbolMap)) {
    if (text.includes(key)) return value;
  }
  const code = /^[A-Z]{3}$/.exec(text);
  return code ? text : fallback;
}

/** Date tolérante : ISO, `JJ/MM/AAAA`, `MM/JJ/AAAA` (désambiguïsé par l'ordre), texte anglais. */
export function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text === '') return null;

  const french = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(text);
  if (french) {
    const day = Number(french[1]);
    const month = Number(french[2]);
    let year = Number(french[3]);
    if (year < 100) year += 2000;
    if (month > 12 && day <= 12) {
      // Format US : MM/JJ/AAAA
      return iso(year, day, month);
    }
    return iso(year, month, day);
  }
  try {
    return normalizeDate(text);
  } catch {
    return null;
  }
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------- types d'activité */

/**
 * Table de correspondance libellé fournisseur -> type canonique.
 *
 * Les clés sont comparées après `foldLabel()` (minuscules, sans accents, sans
 * ponctuation). Chaque connecteur peut étendre cette table, mais le socle commun
 * couvre déjà les libellés rencontrés chez DEGIRO, Trade Republic, Revolut et
 * les exports bancaires français.
 */
export const ACTIVITY_LABEL_MAP: Readonly<Record<string, ActivityType>> = {
  // achats
  buy: 'BUY',
  achat: 'BUY',
  achatcomptetitres: 'BUY',
  souscription: 'BUY',
  orderbuy: 'BUY',
  savingsplan: 'BUY',
  planepargne: 'BUY',
  // ventes
  sell: 'SELL',
  vente: 'SELL',
  ordersell: 'SELL',
  // revenus de titres
  dividend: 'DIVIDEND',
  dividende: 'DIVIDEND',
  dividends: 'DIVIDEND',
  coupon: 'DIVIDEND',
  distribution: 'DIVIDEND',
  interest: 'INTEREST',
  interet: 'INTEREST',
  interets: 'INTEREST',
  zinsen: 'INTEREST',
  staking: 'STAKING_REWARD',
  stakingreward: 'STAKING_REWARD',
  reward: 'STAKING_REWARD',
  airdrop: 'STAKING_REWARD',
  // flux de trésorerie
  deposit: 'DEPOSIT',
  depot: 'DEPOSIT',
  versesement: 'DEPOSIT',
  versement: 'DEPOSIT',
  einzahlung: 'DEPOSIT',
  virementrecu: 'DEPOSIT',
  withdrawal: 'WITHDRAWAL',
  retrait: 'WITHDRAWAL',
  auszahlung: 'WITHDRAWAL',
  virementemis: 'WITHDRAWAL',
  transferin: 'TRANSFER_IN',
  virementinterneentrant: 'TRANSFER_IN',
  transferout: 'TRANSFER_OUT',
  virementinternesortant: 'TRANSFER_OUT',
  // coûts
  fee: 'FEE',
  fees: 'FEE',
  frais: 'FEE',
  commission: 'FEE',
  gebuhren: 'FEE',
  tax: 'TAX',
  taxe: 'TAX',
  impots: 'TAX',
  prelevementfiscal: 'TAX',
  // dépenses bancaires
  bankexpense: 'BANK_EXPENSE',
  paiement: 'BANK_EXPENSE',
  paiementcarte: 'BANK_EXPENSE',
  cardpayment: 'BANK_EXPENSE',
  prelevement: 'BANK_EXPENSE',
  // crypto
  cryptotransfer: 'CRYPTO_TRANSFER',
  cryptoswap: 'CRYPTO_SWAP',
  swap: 'CRYPTO_SWAP',
  exchange: 'CRYPTO_SWAP',
  // immobilier
  rent: 'RENT',
  loyer: 'RENT',
  rentreceived: 'RENT',
  realestateexpense: 'REAL_ESTATE_EXPENSE',
  chargecopropriete: 'REAL_ESTATE_EXPENSE',
  taxefonciere: 'REAL_ESTATE_EXPENSE',
  // divers
  split: 'SPLIT',
  valuationupdate: 'VALUATION_UPDATE',
};

export function foldLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Détermine le type d'activité à partir d'un libellé, avec repli sur le signe du
 * montant et la présence d'une quantité. Retourne `null` si indéterminable :
 * l'assistant d'import demandera alors à l'utilisateur de mapper la colonne.
 */
export function detectActivityType(
  label: string | null | undefined,
  options: { amount?: number | null; hasQuantity?: boolean } = {},
): ActivityType | null {
  if (label) {
    const folded = foldLabel(label);
    const direct = ACTIVITY_LABEL_MAP[folded];
    if (direct) return direct;
    for (const [key, value] of Object.entries(ACTIVITY_LABEL_MAP)) {
      if (folded.includes(key)) return value;
    }
  }
  const amount = options.amount ?? null;
  if (amount !== null) {
    if (options.hasQuantity) return amount < 0 ? 'BUY' : 'SELL';
    return amount < 0 ? 'WITHDRAWAL' : 'DEPOSIT';
  }
  return null;
}

/** Classe une opération dans une grande catégorie d'analyse (revenus, coûts, transferts). */
export type ActivityBucket = 'INCOME' | 'COST' | 'INVESTMENT' | 'TRANSFER' | 'VALUATION' | 'OTHER';

export function bucketOf(type: ActivityType): ActivityBucket {
  switch (type) {
    case 'DIVIDEND':
    case 'INTEREST':
    case 'RENT':
    case 'STAKING_REWARD':
      return 'INCOME';
    case 'FEE':
    case 'TAX':
    case 'BANK_EXPENSE':
    case 'REAL_ESTATE_EXPENSE':
      return 'COST';
    case 'BUY':
    case 'SELL':
      return 'INVESTMENT';
    case 'DEPOSIT':
    case 'WITHDRAWAL':
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'CRYPTO_TRANSFER':
      return 'TRANSFER';
    case 'VALUATION_UPDATE':
    case 'SPLIT':
      return 'VALUATION';
    default:
      return 'OTHER';
  }
}