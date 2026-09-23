/**
 * Contrat d'API partagé entre le backend (`apps/api`) et le frontend (`apps/web`).
 *
 * Ce fichier est la SOURCE DE VÉRITÉ des échanges HTTP. Toute évolution d'un
 * endpoint doit passer par ici : si le frontend compile, les routes existent.
 */

/* ------------------------------------------------------------------ erreurs */

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  /**
   * Identifiants refusés (connexion, code de récupération, mot de passe actuel).
   * Distinct de `UNAUTHENTICATED` — qui signifie « session absente ou expirée » —
   * pour que l'interface ne parle pas de session expirée à quelqu'un qui s'est
   * simplement trompé de mot de passe.
   */
  | 'INVALID_CREDENTIALS'
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

export type AccountRole = 'OWNER' | 'MEMBER';

export interface SessionResponse {
  readonly authenticated: boolean;
  /** Jeton CSRF à renvoyer dans l'en-tête `x-csrf-token` sur les écritures. */
  readonly csrfToken: string | null;
  readonly needsSetup: boolean;
  /** Identifiant du compte connecté (`null` = compte historique sans identifiant). */
  readonly username: string | null;
  readonly role: AccountRole | null;
  /** Nombre de comptes existants : 0 déclenche la création du premier compte. */
  readonly accountsCount: number;
  /**
   * true = l'identifiant est demandé à la connexion. C'est le cas dès qu'un
   * compte porte un identifiant ; une installation d'origine (un seul compte
   * sans identifiant) garde l'écran « mot de passe seul ».
   */
  readonly usernameRequired: boolean;
  /** Nom affiché du compte connecté (facultatif). */
  readonly displayName?: string | null;
  /**
   * true = le serveur sait envoyer un e-mail (SMTP configuré) : le parcours
   * « Mot de passe oublié » propose alors un lien par e-mail.
   */
  readonly emailResetAvailable?: boolean;
}

/** Profil du compte connecté. L'e-mail est déchiffré pour son seul titulaire. */
export interface ProfileResponse {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: AccountRole;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly passwordChangedAt: string | null;
  readonly hasRecoveryCode: boolean;
}

export interface UpdateProfileRequest {
  readonly displayName?: string | null;
  readonly email?: string | null;
  readonly username?: string;
}

/** Une session ouverte (appareil connecté). Jamais le jeton lui-même. */
export interface DeviceSessionDto {
  readonly id: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** Libellé lisible déduit du user-agent (« Chrome sur macOS »). */
  readonly device: string;
  readonly ip: string | null;
}

export interface DeviceSessionListResponse {
  readonly sessions: readonly DeviceSessionDto[];
}

export interface ForgotPasswordRequest {
  /** Identifiant OU adresse e-mail. */
  readonly identifier: string;
}

export interface ForgotPasswordResponse {
  /** Toujours le même message, que le compte existe ou non. */
  readonly message: string;
}

export interface ResetPasswordRequest {
  readonly token: string;
  readonly newPassword: string;
}

export interface LoginRequest {
  readonly password: string;
  readonly username?: string | null;
}

export interface SetupRequest {
  readonly password: string;
  readonly username?: string | null;
  readonly displayName?: string | null;
  readonly email?: string | null;
}

/**
 * Réponse de création de compte : le code de récupération n'est affiché qu'UNE
 * fois. Seule son empreinte est conservée côté serveur — il est donc impossible
 * de le relire ensuite, y compris pour l'application elle-même.
 */
export interface AccountCreatedResponse {
  readonly account: AccountSummaryDto;
  readonly recoveryCode: string;
}

export interface AccountSummaryDto {
  readonly id: string;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly role: AccountRole;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly passwordChangedAt: string | null;
  /** true = un code de récupération existe pour ce compte (jamais relisible). */
  readonly hasRecoveryCode: boolean;
  /** true = une adresse e-mail (chiffrée) est enregistrée. */
  readonly hasEmail?: boolean;
}

export interface AccountListResponse {
  readonly accounts: readonly AccountSummaryDto[];
}

export interface CreateAccountRequest {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string | null;
  readonly role?: AccountRole;
  /**
   * Identifiant à donner au compte du créateur s'il n'en a pas encore : sans
   * cela, il ne pourrait plus se connecter dès qu'un second compte existe.
   */
  readonly ownerUsername?: string | null;
}

export interface ChangePasswordRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface RecoveryRequest {
  readonly recoveryCode: string;
  readonly newPassword: string;
  readonly username?: string | null;
}

export interface RecoveryResponse {
  readonly username: string | null;
  /** Nouveau code, à conserver : l'ancien ne fonctionne plus. */
  readonly recoveryCode: string;
}

/**
 * Après un changement de mot de passe, la session courante est révoquée : le
 * client doit revenir à l'écran de connexion. Le nouveau code de récupération
 * est renvoyé UNE fois (l'ancien ne fonctionne plus).
 */
export interface ChangePasswordResponse {
  readonly recoveryCode: string;
}

/* --------------------------------------------------------------- patrimoine */

export type PeriodKey = '1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y' | '5Y' | 'MAX';

export interface SeriesPoint {
  readonly date: string;
  readonly total: number;
}

export interface VariationDto {
  /** Variation en unités de la devise du portefeuille (pas en %). */
  readonly absolute: number;
  /** Variation en POINTS de pourcentage (10 = +10 %), pas en ratio. */
  readonly percent: number;
}

export interface AllocationSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly percent: number;
}

export type HistorySource = 'RECONSTRUCTED' | 'RECORDED' | 'MIXED';

export interface NetWorthResponse {
  readonly asOf: string;
  /**
   * Origine de la série : `RECONSTRUCTED` (recalculée depuis les activités et les
   * cours), `RECORDED` (relevés quotidiens enregistrés par l'application depuis
   * son installation), `MIXED` (les deux). Ne jamais présenter une reconstitution
   * comme une observation réelle.
   */
  readonly historySource: HistorySource;
  /** Premier jour effectivement enregistré (et non reconstruit), ou `null`. */
  readonly recordedSince: string | null;
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
  /** TWR en POINTS de pourcentage. `null` = non calculable (historique insuffisant). */
  readonly twr: number | null;
  /** XIRR annualisé en POINTS de pourcentage. `null` = aucune solution trouvée. */
  readonly xirr: number | null;
  /** Pire baisse depuis un sommet, en POINTS de pourcentage (valeur négative). */
  readonly maxDrawdown: number | null;
  /** TWR annualisé, en POINTS de pourcentage. */
  readonly annualized: number | null;
  readonly period: PeriodKey;
  /** Explique pourquoi une métrique est `null` : jamais de valeur inventée. */
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

/* ------------------------------------------------------------- comptes (CRUD) */

/**
 * Compte exposé à l'interface, toujours en camelCase : aucune ligne SQL brute
 * (snake_case) ne doit atteindre le client.
 */
export interface AccountDto {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly providerId: string;
  readonly currency: string;
  readonly initialBalance: number;
  readonly isActive: boolean;
  readonly externalAccountId: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAccountRequest {
  readonly name: string;
  readonly type: string;
  readonly providerId: string;
  readonly currency: string;
  readonly initialBalance?: number;
  readonly notes?: string;
}

export interface UpdateAccountRequest extends Partial<CreateAccountRequest> {
  readonly isActive?: boolean;
}

export interface AccountOverviewResponse {
  readonly count: number;
  readonly accounts: readonly AccountDto[];
}

/** Réponse générique pour une opération sans contenu propre. */
export interface OkResponse {
  readonly ok: boolean;
}

export interface CashFlowCreatedResponse {
  readonly id: string;
  readonly accountId: string;
}

/* --------------------------------------------------- positions saisies à la main */

export interface ManualPositionDto {
  readonly activityId: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly averageCost: number;
  readonly costBasis: number;
  readonly currency: string;
  readonly date: string;
  /** `CREATED` / `UPDATED` / `SKIPPED` lors d'une écriture, `null` en lecture. */
  readonly outcome: 'CREATED' | 'UPDATED' | 'SKIPPED' | null;
}

/* ------------------------------------------------------- état des connexions */

export interface ConnectionTestResultDto {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  /** Vrai si une action humaine est attendue (validation dans l'app, captcha...). */
  readonly requiresUserAction?: boolean;
  /** Consigne actionnable, en clair, à afficher à l'utilisateur. */
  readonly userAction?: string | null;
}

export interface SyncOutcomeDto {
  readonly syncRunId: string;
  readonly connectionId: string;
  readonly providerId: string;
  readonly status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'AUTH_REQUIRED';
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: number;
  /** Message compréhensible (jamais une trace technique). */
  readonly message: string | null;
  /** Code d'erreur normalisé (`ConnectorError.kind`), `null` si succès. */
  readonly errorCode: string | null;
  readonly durationMs: number;
  /** Avertissements non bloquants (donnée approximée, taux manquant...). */
  readonly warnings: readonly string[];
}

export interface SyncAllResponse {
  readonly results: readonly SyncOutcomeDto[];
  readonly summary: {
    readonly total: number;
    readonly succeeded: number;
    readonly partial: number;
    readonly failed: number;
    readonly authRequired: number;
    readonly created: number;
    readonly updated: number;
  };
}

/** État d'un wallet EVM tel qu'affiché dans l'interface. */
export interface WalletChainStatusDto {
  readonly chain: string;
  readonly tokens: number;
  readonly valueEur: number;
  readonly lastSyncedAt: string | null;
  readonly lastBlock: number | null;
  readonly error: string | null;
}

export interface WalletStatusDto {
  readonly accountId: string;
  readonly name: string;
  readonly address: string;
  readonly chains: readonly WalletChainStatusDto[];
  readonly tokenCount: number;
  readonly valueEur: number;
  readonly lastSyncedAt: string | null;
  readonly error: string | null;
}

export interface WalletResyncResponse {
  readonly outcome: SyncOutcomeDto;
  readonly wallet: WalletStatusDto;
}

/* -------------------------------------------------------------- sauvegardes */

export interface BackupFileDto {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly kind: 'sqlite' | 'json' | 'csv';
}

export interface BackupExportResponse {
  readonly files: readonly BackupFileDto[];
  /** Tables volontairement exclues d'une sauvegarde (secrets, sessions...). */
  readonly excludedTables: readonly string[];
}

/* ------------------------------------------------------------------- audit */

export interface AuditEntryDto {
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly entity: string | null;
  readonly entityId: string | null;
  readonly details: unknown;
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
  /** Code normalisé de l'erreur éventuelle (`AUTH_REQUIRED`, `RATE_LIMITED`...). */
  readonly errorCode?: string | null;
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
  /** Heure du relevé quotidien du patrimoine (cron). */
  readonly snapshotCron: string;
  readonly security: {
    readonly sessionTtlMinutes: number;
    readonly argon2Params: string;
    readonly encryption: string;
    /** Les sauvegardes sont-elles chiffrées sur le disque ? */
    readonly backupsEncrypted?: boolean;
    /** Envoi d'e-mails configuré (liens de réinitialisation). */
    readonly emailConfigured?: boolean;
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