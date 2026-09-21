/**
 * Contrat d'API partagé entre le backend (`apps/api`) et le frontend (`apps/web`).
 *
 * Ce fichier est la SOURCE DE VÉRITÉ des échanges HTTP. Toute évolution d'un
 * endpoint doit passer par ici : si le frontend compile, les routes existent.
 */

/* ------------------------------------------------------------------ erreurs */

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'CONNECTOR_ERROR'
  | 'INTERNAL';

export interface ApiError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: unknown;
  };
}

/* -------------------------------------------------------------------- auth */

export interface SessionResponse {
  readonly authenticated: boolean;
  /** Jeton CSRF à renvoyer dans l'en-tête `x-csrf-token` sur les écritures. */
  readonly csrfToken: string | null;
  readonly needsSetup: boolean;
}

export interface LoginRequest {
  readonly password: string;
}

/* --------------------------------------------------------------- patrimoine */

export type PeriodKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | '5Y' | 'MAX';

export interface SeriesPoint {
  readonly date: string;
  readonly total: number;
}

export interface VariationDto {
  readonly absolute: number;
  readonly percent: number;
}

export interface AllocationSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly percent: number;
}

export interface NetWorthResponse {
  readonly asOf: string;
  readonly currency: string;
  readonly total: number;
  readonly variationToday: VariationDto;
  readonly variation1M: VariationDto;
  readonly variationYtd: VariationDto;
  readonly variation1Y: VariationDto;
  readonly variationAll: VariationDto;
  readonly series: readonly SeriesPoint[];
  readonly byClass: readonly AllocationSlice[];
  readonly byProvider: readonly AllocationSlice[];
  readonly byCurrency: readonly AllocationSlice[];
  /** Comptes exclus du total faute de taux de change : jamais masqués silencieusement. */
  readonly warnings: readonly string[];
}

export interface AccountSummary {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly providerId: string;
  readonly currency: string;
  readonly value: number;
  readonly valueCurrency: string;
  readonly cash: number;
  readonly invested: number;
  readonly unrealizedPnl: number;
  readonly unrealizedPnlPercent: number;
  readonly realizedPnl: number;
  readonly lastActivityDate: string | null;
  readonly isActive: boolean;
  readonly externalAccountId: string | null;
}

export interface AccountsResponse {
  readonly accounts: readonly AccountSummary[];
  readonly totals: {
    readonly byType: readonly AllocationSlice[];
    readonly byProvider: readonly AllocationSlice[];
    readonly total: number;
  };
}

export interface PositionDto {
  readonly instrumentId: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string;
  readonly kind: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly quantity: number;
  readonly averageCost: number;
  readonly lastPrice: number | null;
  readonly currency: string;
  readonly marketValue: number;
  readonly marketValueEur: number;
  readonly costBasis: number;
  readonly unrealizedPnl: number;
  readonly unrealizedPnlPercent: number;
  readonly realizedPnl: number;
  readonly dividends: number;
  readonly fees: number;
  readonly weightPercent: number;
  readonly priceDate: string | null;
}

export interface InvestmentsResponse {
  readonly positions: readonly PositionDto[];
  readonly currency: string;
  readonly totals: {
    readonly marketValue: number;
    readonly costBasis: number;
    readonly unrealizedPnl: number;
    readonly unrealizedPnlPercent: number;
    readonly realizedPnl: number;
    readonly dividends: number;
    readonly fees: number;
  };
  readonly performance: PerformanceMetricsDto;
  readonly allocation: readonly AllocationSlice[];
  readonly warnings: readonly string[];
}

export interface PerformanceMetricsDto {
  readonly twr: number | null;
  readonly xirr: number | null;
  readonly maxDrawdown: number | null;
  readonly annualized: number | null;
  readonly period: PeriodKey;
  readonly note: string | null;
}

/* -------------------------------------------------------------------- crypto */

export interface CryptoAssetDto {
  readonly chain: string;
  readonly symbol: string;
  readonly name: string;
  readonly contractAddress: string | null;
  readonly quantity: number;
  readonly price: number | null;
  readonly currency: string;
  readonly valueEur: number;
  readonly isNative: boolean;
}

export interface CryptoWalletDto {
  readonly accountId: string;
  readonly name: string;
  readonly address: string;
  readonly chains: readonly string[];
  readonly valueEur: number;
  readonly assets: readonly CryptoAssetDto[];
  readonly lastSyncedAt: string | null;
}

export interface CryptoResponse {
  readonly wallets: readonly CryptoWalletDto[];
  readonly totalEur: number;
  readonly allocation: readonly AllocationSlice[];
  readonly byChain: readonly AllocationSlice[];
  readonly warnings: readonly string[];
}

/* ---------------------------------------------------------------- immobilier */

export interface PropertyLoanDto {
  readonly loanType: string;
  readonly principal: number;
  readonly remainingPrincipal: number;
  readonly annualRate: number;
  readonly months: number;
  readonly startDate: string;
  readonly monthlyPayment: number;
  readonly insuranceMonthly: number;
  readonly totalInterest: number;
  readonly totalInsurance: number;
  readonly interestPaid: number;
  readonly principalRepaid: number;
  readonly endDate: string;
}

export interface PropertyCashFlowDto {
  readonly id: string;
  readonly direction: 'INCOME' | 'EXPENSE';
  readonly category: string;
  readonly label: string;
  readonly amount: number;
  readonly currency: string;
  readonly date: string;
  readonly recurrence: 'ONE_OFF' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  readonly received: boolean;
}

export interface PropertyDto {
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
  readonly notes: string | null;
  readonly loan: PropertyLoanDto | null;
  readonly cashFlows: readonly PropertyCashFlowDto[];
  readonly appreciationHistory: readonly { date: string; value: number; note: string | null }[];
  readonly metrics: {
    readonly totalCost: number;
    readonly equity: number;
    readonly loanBalance: number;
    readonly grossYield: number;
    readonly netYield: number;
    readonly yieldOnEquity: number;
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
    readonly occupancyRate: number;
  };
  readonly amortization: readonly {
    index: number;
    date: string;
    payment: number;
    interest: number;
    principal: number;
    insurance: number;
    remaining: number;
  }[];
}

export interface RealEstateResponse {
  readonly properties: readonly PropertyDto[];
  readonly totals: {
    readonly currentValue: number;
    readonly loanBalance: number;
    readonly equity: number;
    readonly annualIncome: number;
    readonly annualExpenses: number;
    readonly annualCashFlowAfterLoan: number;
    readonly interestPaid: number;
    readonly unrealizedGain: number;
  };
  readonly portfolio: {
    readonly grossYield: number;
    readonly netYield: number;
    readonly monthlyCashFlow: number;
  };
}

/* -------------------------------------------------------------- transactions */

export interface TransactionDto {
  readonly id: string;
  readonly date: string;
  readonly type: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly providerId: string;
  readonly instrumentId: string | null;
  readonly instrumentName: string | null;
  readonly isin: string | null;
  readonly description: string | null;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly amount: number;
  readonly currency: string;
  readonly amountEur: number;
  readonly fees: number;
  readonly taxes: number;
  readonly source: string;
}

export interface TransactionsQuery {
  readonly from?: string;
  readonly to?: string;
  readonly providerId?: string;
  readonly accountId?: string;
  readonly type?: string;
  readonly currency?: string;
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TransactionsResponse {
  readonly items: readonly TransactionDto[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly totalsByType: readonly AllocationSlice[];
}

/* ------------------------------------------------------------------ revenus */

export interface IncomeResponse {
  readonly period: PeriodKey;
  readonly total: number;
  readonly byType: readonly AllocationSlice[];
  readonly byMonth: readonly { month: string; value: number }[];
  readonly byAccount: readonly AllocationSlice[];
  readonly byProvider: readonly AllocationSlice[];
  readonly forwardAnnualized: number;
  readonly items: readonly TransactionDto[];
}

/* ---------------------------------------------------------------- analytics */

export interface AnalyticsResponse {
  readonly period: PeriodKey;
  readonly performance: PerformanceMetricsDto;
  readonly byAccount: readonly {
    accountId: string;
    accountName: string;
    providerId: string;
    value: number;
    performance: PerformanceMetricsDto;
    contribution: number;
  }[];
  readonly allocation: {
    readonly byClass: readonly AllocationSlice[];
    readonly byInstrument: readonly AllocationSlice[];
    readonly byCurrency: readonly AllocationSlice[];
    readonly byCountry: readonly AllocationSlice[];
  };
  readonly risk: {
    readonly maxDrawdown: number | null;
    readonly volatility: number | null;
    readonly cryptoShare: number;
    readonly realEstateShare: number;
    readonly leverage: number;
  };
  readonly monthly: readonly {
    month: string;
    invested: number;
    income: number;
    expenses: number;
    netWorth: number;
  }[];
}

/* -------------------------------------------------------------- connexions */

export interface ConnectionDto {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly label: string;
  readonly status: string;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly requiresUserAction: boolean;
  readonly needsReauth: boolean;
  readonly config: Readonly<Record<string, string>>;
  readonly secretNames: readonly string[];
  readonly capabilities: {
    readonly accounts: boolean;
    readonly balances: boolean;
    readonly positions: boolean;
    readonly transactions: boolean;
    readonly income: boolean;
    readonly api: boolean;
  };
  readonly importFormats: readonly { id: string; label: string; kind: string }[];
}

export interface SyncRunDto {
  readonly syncRunId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly trigger: 'MANUAL' | 'SCHEDULED' | 'IMPORT';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'AUTH_REQUIRED';
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
  readonly durationMs: number | null;
  readonly message: string | null;
}

export interface ConnectionsResponse {
  readonly connections: readonly ConnectionDto[];
  readonly providers: readonly {
    providerId: string;
    providerName: string;
    implemented: boolean;
    apiSupported: boolean;
    importFormats: readonly string[];
    requiredConfig: readonly string[];
    requiredSecrets: readonly string[];
    notes: string;
  }[];
  readonly scheduler: {
    readonly enabled: boolean;
    readonly cron: string | null;
    readonly lastRunAt: string | null;
    readonly nextRunAt: string | null;
  };
}

/* ------------------------------------------------------------------ imports */

export interface ImportAnalyzeRequest {
  readonly filename: string;
  readonly content: string;
  readonly connectionId?: string;
  readonly accountId?: string;
  readonly forceFormatId?: string;
  readonly columnMap?: Readonly<Record<string, string>>;
}

export interface ImportPreviewRow {
  readonly line: number;
  readonly date: string | null;
  readonly type: string | null;
  readonly description: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly isin: string | null;
  readonly status: 'NEW' | 'DUPLICATE_EXTERNAL_ID' | 'DUPLICATE_FINGERPRINT' | 'ERROR';
  readonly reason: string | null;
}

export interface ImportAnalyzeResponse {
  readonly detectedFormatId: string | null;
  readonly detectedFormatLabel: string | null;
  readonly detectionScore: number;
  readonly availableFormats: readonly { id: string; label: string; providerId: string; score: number }[];
  readonly columns: readonly string[];
  readonly suggestedMap: Readonly<Record<string, string>>;
  readonly unmappedColumns: readonly string[];
  readonly rows: readonly ImportPreviewRow[];
  readonly summary: {
    readonly parsed: number;
    readonly new: number;
    readonly duplicates: number;
    readonly errors: number;
    readonly dateRange: { from: string | null; to: string | null };
    readonly currencies: readonly string[];
    readonly totalAmount: number;
  };
  readonly warnings: readonly string[];
}

export interface ImportCommitRequest extends ImportAnalyzeRequest {
  readonly dryRun?: boolean;
}

export interface ImportCommitResponse {
  readonly importId: string;
  readonly created: number;
  readonly skipped: number;
  readonly errors: number;
  readonly message: string;
}

export interface ImportHistoryDto {
  readonly importId: string;
  readonly filename: string;
  readonly formatId: string | null;
  readonly accountId: string | null;
  readonly importedAt: string;
  readonly created: number;
  readonly skipped: number;
  readonly errors: number;
}

/* -------------------------------------------------------------- paramètres */

export interface SettingsDto {
  readonly baseCurrency: string;
  readonly theme: 'system' | 'light' | 'dark';
  readonly marketDataProviders: readonly string[];
  readonly backup: {
    readonly enabled: boolean;
    readonly cron: string | null;
    readonly directory: string;
    readonly lastBackupAt: string | null;
    readonly retentionDays: number;
  };
  readonly scheduler: { readonly enabled: boolean; readonly cron: string };
  readonly security: {
    readonly sessionTtlMinutes: number;
    readonly argon2Params: string;
    readonly encryption: string;
  };
  readonly version: string;
  readonly databasePath: string;
}

/* -------------------------------------------------------------- utilitaires */

export interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly database: { readonly ok: boolean; readonly file: string; readonly migrations: number };
  readonly connectors: number;
  readonly lastSyncAt: string | null;
}

export interface MarketDataRefreshResponse {
  readonly refreshed: number;
  readonly failed: number;
  readonly providers: readonly { provider: string; instruments: number; errors: number }[];
  readonly message: string;
}