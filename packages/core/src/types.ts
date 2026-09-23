/**
 * Modèle métier canonique de SuiviInvest.
 *
 * Vocabulaire aligné sur Wealthfolio (accounts / activities / assets / valuations /
 * quotes / fx) de manière à pouvoir échanger des données avec l'écosystème existant,
 * mais le modèle est autonome : aucun type de ce fichier ne dépend d'un connecteur.
 *
 * Règle absolue : ce module est PUR. Pas d'I/O, pas de dépendance à SQLite, HTTP
 * ou au framework web.
 */

/* ------------------------------------------------------------------ devises */

/** Code devise ISO-4217 (ex. "EUR") ou symbole crypto normalisé (ex. "BTC"). */
export type CurrencyCode = string;

/**
 * Montant monétaire. On conserve TOUJOURS la devise d'origine afin de ne jamais
 * perdre l'information lors des conversions (exigence multi-devises).
 *
 * Les calculs passent par `money.ts` qui borne la précision à `MONEY_SCALE`
 * décimales pour éviter la dérive des flottants.
 */
export interface Money {
  readonly amount: number;
  readonly currency: CurrencyCode;
}

/** Taux de change à une date donnée, exprimé comme : 1 unité de `base` = `rate` unités de `quote`. */
export interface FxRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Date au format ISO `YYYY-MM-DD`. */
  readonly date: string;
  readonly rate: number;
  readonly source: string;
}

/* ------------------------------------------------------------------ actifs */

export type AssetKind =
  | 'EQUITY'
  | 'ETF'
  | 'FUND'
  | 'BOND'
  | 'CRYPTO'
  | 'CASH'
  | 'REAL_ESTATE'
  | 'OTHER';

/** Identifiant d'instrument. ISIN prioritaire quand il existe (exigence market data). */
export interface Instrument {
  readonly id: string;
  readonly kind: AssetKind;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string;
  readonly currency: CurrencyCode;
  /** Place de cotation (MIC quand connue, ex. "XPAR"). */
  readonly exchange: string | null;
  /** Réseau blockchain pour les actifs crypto (ex. "ethereum"). */
  readonly chain: string | null;
  /** Adresse du contrat pour les tokens ERC-20. */
  readonly contractAddress: string | null;
  /** Nombre de décimales natives (crypto) — 18 pour l'ETH par défaut. */
  readonly decimals: number | null;
}

/* ----------------------------------------------------------------- comptes */

export type AccountType =
  | 'SECURITIES' // compte-titres, PEA
  | 'CASH' // compte bancaire, livret, espèces
  | 'CRYPTO' // wallet / exchange
  | 'REAL_ESTATE' // bien immobilier
  | 'LIABILITY' // crédit, dette
  | 'OTHER';

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly providerId: ProviderId;
  readonly currency: CurrencyCode;
  /** Solde de référence des comptes CASH (le solde réel vient des activités). */
  readonly initialBalance: number;
  readonly isActive: boolean;
  readonly createdAt: string;
  /** Identifiant du compte chez le fournisseur (externalAccountId). */
  readonly externalAccountId: string | null;
}

/* ------------------------------------------------------------- fournisseurs */

export type ProviderId =
  | 'degiro'
  | 'trade_republic'
  | 'credit_agricole'
  | 'revolut'
  | 'metamask'
  | 'enable_banking'
  | 'bitcoin'
  | 'solana'
  | 'binance'
  | 'kraken'
  | 'coinbase'
  | 'bitpanda'
  | 'manual'
  | 'csv';

export type SyncStatus =
  | 'DISCONNECTED'
  | 'CONNECTED'
  | 'SYNCING'
  | 'SYNCED'
  | 'AUTH_REQUIRED'
  | 'ERROR';

export interface Connection {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly status: SyncStatus;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  /** Paramètres non secrets (identifiant, adresse de wallet, chemins...). */
  readonly config: Readonly<Record<string, string>>;
  /** Nom des secrets stockés chiffrés au repos (jamais leur valeur). */
  readonly secretRefs: readonly string[];
}

/* -------------------------------------------------------------- activités */

/**
 * Types d'activité génériques. Ce sont les types persistés et affichés ; chaque
 * connecteur doit normaliser ses données brutes vers cette liste.
 */
export type ActivityType =
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'FEE'
  | 'TAX'
  | 'SPLIT'
  | 'RENT'
  | 'REAL_ESTATE_EXPENSE'
  | 'BANK_EXPENSE'
  | 'CRYPTO_TRANSFER'
  | 'CRYPTO_SWAP'
  | 'STAKING_REWARD'
  | 'VALUATION_UPDATE';

/**
 * Activité financière normalisée : LA brique commune à tous les providers.
 *
 * Conventions de signe (importantes pour les calculs de performance) :
 * - `quantity` : toujours positive (nombre de titres/parts).
 * - `unitPrice` : prix unitaire dans `currency` (positif).
 * - `amount`    : flux de trésorerie **net** vu depuis le compte, signé.
 *                 < 0 = sortie d'argent (achat, frais, dépôt sur un crédit)
 *                 > 0 = entrée d'argent (vente, dividende, loyer, virement reçu)
 * - `fees` / `taxes` : toujours positifs, déjà inclus dans `amount`.
 */
export interface Activity {
  readonly id: string;
  readonly accountId: string;
  readonly type: ActivityType;
  readonly date: string;
  readonly instrumentId: string | null;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly fees: number;
  readonly taxes: number;
  readonly fxRateToBase: number | null;
  readonly description: string | null;
  /** Provenance : permet la traçabilité et la déduplication. */
  readonly provenance: ActivityProvenance;
}

export interface ActivityProvenance {
  readonly providerId: ProviderId;
  readonly externalAccountId: string | null;
  readonly externalTransactionId: string | null;
  readonly externalAssetId: string | null;
  readonly rawSourceType: string | null;
  readonly lastSyncedAt: string;
  /** Empreinte utilisée en repli quand aucun identifiant externe n'est disponible. */
  readonly dedupHash: string;
  /** Id du lot de synchronisation / de l'import qui a créé la ligne. */
  readonly syncRunId: string | null;
}

/* ------------------------------------------------------------ valorisation */

/** Mise à jour de valeur : soit un prix de marché, soit une estimation d'actif. */
export interface Valuation {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string | null;
  readonly date: string;
  readonly value: number;
  readonly currency: CurrencyCode;
  readonly source: 'MARKET' | 'MANUAL' | 'APPRAISAL' | 'CONNECTOR';
  readonly note: string | null;
}

/** Cours d'un instrument à une date (issu du module market data). */
export interface Quote {
  readonly instrumentId: string;
  readonly date: string;
  readonly close: number;
  readonly currency: CurrencyCode;
  readonly provider: string;
  readonly fetchedAt: string;
}

/* -------------------------------------------------------------- positions */

export interface Position {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly quantity: number;
  /** Prix de revient unitaire (PRU), frais inclus. */
  readonly averageCost: number;
  readonly costBasis: number;
  readonly currency: CurrencyCode;
  readonly lastPrice: number | null;
  readonly marketValue: number;
  /** Plus-value latente = marketValue - costBasis. */
  readonly unrealizedPnl: number;
  readonly realizedPnl: number;
  readonly dividends: number;
  readonly fees: number;
  readonly firstActivityDate: string | null;
}

/* ------------------------------------------------------------- patrimoine */

export type WealthClass =
  | 'EQUITIES' // actions / ETF
  | 'CRYPTO'
  | 'REAL_ESTATE'
  | 'CASH'
  | 'OTHER_ASSETS'
  | 'LIABILITIES';

export interface NetWorthPoint {
  readonly date: string;
  readonly total: number;
  readonly byClass: Readonly<Record<WealthClass, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
}

export interface NetWorthVariation {
  readonly absolute: number;
  readonly percent: number;
}

export interface NetWorthSummary {
  readonly asOf: string;
  readonly currency: CurrencyCode;
  readonly total: number;
  readonly byClass: Readonly<Record<WealthClass, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly variationToday: NetWorthVariation;
  readonly variation1M: NetWorthVariation;
  readonly variationYtd: NetWorthVariation;
  readonly variation1Y: NetWorthVariation;
  readonly variationAll: NetWorthVariation;
}

/* ------------------------------------------------------------- immobilier */

export type LoanType = 'AMORTIZABLE' | 'IN_FINE' | 'VARIABLE' | 'OTHER';

export interface PropertyLoan {
  readonly loanType: LoanType;
  readonly principal: number;
  readonly remainingPrincipal: number;
  readonly annualRate: number;
  readonly months: number;
  readonly startDate: string;
  readonly monthlyPayment: number;
  readonly insuranceMonthly: number;
  readonly interestPaid: number;
  readonly principalRepaid: number;
}

export interface PropertyDetails {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly kind: string;
  readonly address: string | null;
  readonly purchaseDate: string | null;
  readonly purchasePrice: number;
  readonly notaryFees: number;
  readonly agencyFees: number;
  readonly initialWorks: number;
  readonly surfaceM2: number | null;
  readonly currentValue: number;
  readonly appreciationHistory: readonly { date: string; value: number; note: string | null }[];
  readonly notes: string | null;
  readonly loan: PropertyLoan | null;
}

export type PropertyCashFlowDirection = 'INCOME' | 'EXPENSE';

export interface PropertyCashFlowEntry {
  readonly id: string;
  readonly accountId: string;
  readonly direction: PropertyCashFlowDirection;
  readonly category: PropertyCashFlowCategory;
  readonly label: string;
  readonly amount: number;
  readonly currency: CurrencyCode;
  readonly date: string;
  readonly recurrence: 'ONE_OFF' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** Un loyer non encaissé (impayé) est enregistré comme INCOME avec `received = false`. */
  readonly received: boolean;
}

export type PropertyCashFlowCategory =
  | 'RENT'
  | 'RENT_CHARGES'
  | 'OTHER_INCOME'
  | 'PROPERTY_TAX'
  | 'PNO_INSURANCE'
  | 'LOAN_INSURANCE'
  | 'CONDO_FEES'
  | 'WORKS'
  | 'MAINTENANCE'
  | 'AGENCY'
  | 'ACCOUNTANT'
  | 'BANK_FEES'
  | 'VACANCY'
  | 'CUSTOM';

export interface PropertyMetrics {
  readonly accountId: string;
  readonly currentValue: number;
  readonly totalCost: number; // prix d'achat + frais + travaux
  readonly loanBalance: number;
  readonly equity: number; // valeur actuelle - capital restant dû
  readonly grossYield: number; // loyers annuels / valeur actuelle
  readonly netYield: number; // (loyers - charges) / valeur actuelle
  readonly yieldOnEquity: number; // cash-flow net / apport
  readonly downPayment: number;
  readonly monthlyIncome: number;
  readonly monthlyExpenses: number;
  readonly monthlyCashFlow: number;
  readonly monthlyCashFlowAfterLoan: number;
  readonly annualIncome: number;
  readonly annualExpenses: number;
  readonly annualCashFlow: number;
  readonly annualCashFlowAfterLoan: number;
  readonly unrealizedGain: number;
  readonly principalRepaid: number;
  readonly interestPaid: number;
  readonly loanYearlyPayments: number;
  readonly loanYearlyPrincipal: number;
  readonly occupancyRate: number;
}