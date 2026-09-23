import type { AccountType, ActivityType, AssetKind, ProviderId, SyncStatus } from '@suiviinvest/core';

/**
 * Contrat des connecteurs.
 *
 * Règles structurantes (elles sont la raison d'être de ce fichier) :
 *
 * 1. **Aucun connecteur ne touche la base.** Il produit des objets normalisés et
 *    les remet à la couche de service (`SyncTarget`), seule autorisée à écrire.
 * 2. **Read-only absolu.** Un connecteur n'expose ni ordre, ni virement, ni
 *    signature. Le type `Connector` ne contient donc aucune méthode d'écriture
 *    vers le fournisseur : il est impossible d'en ajouter une par accident.
 * 3. **Mode fichier obligatoire pour les API fragiles.** Un connecteur à API
 *    privée ou non officielle déclare au moins un `ImportFormat` : si l'API
 *    casse (DEGIRO, Trade Republic, CA), l'utilisateur garde un chemin via CSV.
 *    Les sources à API officielle (open banking, plateformes crypto) ou
 *    publique (blockchains) en sont dispensées.
 * 4. **Testable hors ligne.** Tout passe par `ctx.http` et `ctx.now`, injectés :
 *    les tests CI n'ont jamais besoin d'identifiants réels.
 */

/* --------------------------------------------------------------- contexte */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Lecture seule des secrets chiffrés. Ne jamais journaliser la valeur retournée. */
export interface SecretReader {
  get(name: string): Promise<string | null>;
  // Volontairement aucune méthode d'écriture : le stockage des secrets est hors
  // du périmètre d'un connecteur.
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** Client HTTP injectable : permet le mock en test et l'ajout de retry/ratelimit. */
export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  json<T>(url: string, options?: HttpRequestOptions): Promise<T>;
  /** Décode un JWT/claims sans vérifier la signature (usage : exp, sous-champs). */
  sleep(ms: number): Promise<void>;
}

/* ------------------------------------------------------------ sidecar */

/**
 * Transport vers un exécutable auxiliaire (sidecar).
 *
 * Pourquoi : certaines sources ne sont exploitables que par une bibliothèque
 * écrite dans un autre langage (DEGIRO et Trade Republic en Python). La lier
 * directement imposerait sa licence et son runtime à toute l'application.
 *
 * Le sidecar est donc un **processus séparé** qui reçoit une requête JSON sur
 * l'entrée standard et répond du JSON sur la sortie standard — ou, si l'URL est
 * configurée, un service HTTP local. Le cœur de l'application ne connaît que
 * cette interface : il peut la simuler en test, la remplacer, ou s'en passer.
 *
 * Contrat de réponse : `{ ok: true, data: ... }` ou `{ ok: false, code, message }`
 * où `code` est un `ConnectorError.kind` (MFA_REQUIRED, SESSION_EXPIRED, ...).
 */
export interface SidecarRequest {
  /** Opération demandée, ex. « degiro.positions », « tr.portfolio ». */
  readonly operation: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /** Secrets nécessaires à l'opération, fournis à la demande, jamais journalisés. */
  readonly secrets?: Readonly<Record<string, string>>;
  /** Durée maximale d'exécution, en millisecondes. */
  readonly timeoutMs?: number;
}

export interface SidecarSuccess<T = unknown> {
  readonly ok: true;
  readonly data: T;
  /** Avertissements non bloquants (donnée approximée, colonne absente...). */
  readonly warnings?: readonly string[];
}

export interface SidecarFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  /** Indique que l'échec est attendu et que réessayer après action utilisateur a du sens. */
  readonly requiresUserAction?: boolean;
}

export type SidecarResponse<T = unknown> = SidecarSuccess<T> | SidecarFailure;

export interface SidecarTransport {
  /** Nom du sidecar (« degiro », « trade-republic ») : utilisé dans les messages d'erreur. */
  readonly name: string;
  /** Indique si le sidecar est configuré et exécutable (binaire ou URL présents). */
  isAvailable(): boolean;
  call<T = unknown>(request: SidecarRequest): Promise<SidecarResponse<T>>;
}

export interface ConnectorContext {
  readonly connectionId: string;
  readonly syncRunId: string;
  /** Paramètres non secrets du connecteur (identifiant, adresse de wallet...). */
  readonly config: Readonly<Record<string, string>>;
  readonly secrets: SecretReader;
  readonly http: HttpClient;
  readonly logger: Logger;
  /** Horloge injectable : les tests manipulent le temps, le code ne l'appelle jamais en direct. */
  readonly now: () => Date;
  /** Signale une étape nécessitant une action humaine (2FA, app mobile...). */
  readonly requestUserAction?: (reason: string, details?: Record<string, string>) => Promise<void>;
  /**
   * Sidecars disponibles, indexés par nom. Optionnel : un connecteur qui en a
   * besoin et n'en trouve pas remonte `NOT_SUPPORTED` avec un message explicite
   * plutôt que d'échouer silencieusement.
   */
  readonly sidecars?: Readonly<Record<string, SidecarTransport>>;
}

/* --------------------------------------------------------- objets normalisés */

export interface NormalizedAccount {
  readonly externalAccountId: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly rawSourceType: string;
  /** Solde connu du fournisseur, s'il est fourni avec le compte. */
  readonly balance?: number | null;
  readonly isActive?: boolean;
}

export interface NormalizedBalance {
  readonly externalAccountId: string;
  readonly date: string;
  readonly cash: number;
  readonly currency: string;
  readonly rawSourceType: string;
}

export interface NormalizedPosition {
  readonly externalAccountId: string;
  readonly externalAssetId: string | null;
  readonly isin: string | null;
  readonly symbol: string | null;
  readonly name: string;
  readonly kind: AssetKind;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly currency: string;
  readonly chain?: string | null;
  readonly contractAddress?: string | null;
  readonly decimals?: number | null;
  readonly rawSourceType: string;
}

export interface NormalizedTransaction {
  readonly externalAccountId: string;
  readonly externalTransactionId: string | null;
  readonly externalAssetId: string | null;
  readonly date: string;
  readonly type: ActivityType;
  readonly description: string;
  readonly quantity: number | null;
  readonly unitPrice: number | null;
  readonly amount: number;
  readonly currency: string;
  readonly fees: number;
  readonly taxes: number;
  readonly rawSourceType: string;
  /**
   * Taux de change appliqué par le fournisseur, quand il le communique
   * (relevés Revolut multi-devises, exports Trade Republic...).
   *
   * Prioritaire sur le taux reconstitué depuis la table `fx_rates` : c'est le
   * taux réellement appliqué à VOTRE opération, donc la seule valeur exacte.
   * `null`/absent = l'application applique son propre taux daté.
   */
  readonly fxRate?: number | null;
}

export interface NormalizedIncome {
  readonly externalAccountId: string;
  readonly externalTransactionId: string | null;
  readonly date: string;
  readonly type: Extract<ActivityType, 'DIVIDEND' | 'INTEREST' | 'RENT' | 'STAKING_REWARD'>;
  readonly description: string;
  readonly amount: number;
  readonly currency: string;
  readonly withholdingTax: number;
  readonly rawSourceType: string;
  /** Taux de change communiqué par la source, prioritaire sur le taux reconstitué. */
  readonly fxRate?: number | null;
}

/* --------------------------------------------------------------- import fichier */

export interface ImportFormat {
  readonly id: string;
  readonly label: string;
  readonly kind: 'CSV' | 'JSON';
  /** Détection automatique du format (entêtes, séparateur, signature). */
  detect(content: string): number; // 0..1
  parse(content: string, options?: ImportParseOptions): ImportParseResult;
}

export interface ImportParseOptions {
  /** Mapping explicite des colonnes (issu de l'assistant d'import). */
  readonly columnMap?: Readonly<Record<string, string>>;
  readonly defaultAccountExternalId?: string;
}

export interface ImportParseResult {
  readonly transactions: readonly NormalizedTransaction[];
  readonly income: readonly NormalizedIncome[];
  readonly positions: readonly NormalizedPosition[];
  readonly detectedColumns: readonly string[];
  readonly unmappedColumns: readonly string[];
  readonly warnings: readonly string[];
  /** Lignes rejetées avec la raison : jamais silencieuses. */
  readonly errors: readonly { line: number; reason: string }[];
}

/* ----------------------------------------------------------------- résultats */

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly status: SyncStatus;
  readonly message: string;
  /** Action humaine requise (2FA, validation app, CAPTCHA...). */
  readonly requiresUserAction?: boolean;
}

export interface SyncCursor {
  readonly value: string | null;
}

export interface SyncWindow {
  /** Synchronisation incrémentale : ne remonter que ce qui est postérieur. */
  readonly since?: string | null;
  readonly cursor?: string | null;
}

export interface SyncStatusReport {
  readonly status: SyncStatus;
  readonly lastSyncAt: string | null;
  readonly message: string;
  readonly requiresUserAction: boolean;
}

/* ------------------------------------------------------------------ contrat */

export interface ConnectorCapabilities {
  readonly accounts: boolean;
  readonly balances: boolean;
  readonly positions: boolean;
  readonly transactions: boolean;
  readonly income: boolean;
  /** `true` si la source expose une API exploitable ; `false` = import de fichiers seulement. */
  readonly api: boolean;
  /**
   * `true` = les positions renvoyées sont l'inventaire COMPLET du compte : un
   * actif absent a été vendu ou transféré, sa position passe à zéro.
   */
  readonly completePositions?: boolean;
}

export interface Connector {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ConnectorCapabilities;
  /** Formats de fichiers supportés (repli toujours disponible). */
  readonly importFormats: readonly ImportFormat[];
  /** Variables de configuration attendues (non secrètes) et secrets requis. */
  readonly requiredConfig: readonly string[];
  readonly requiredSecrets: readonly string[];

  testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult>;
  syncAccounts(ctx: ConnectorContext): Promise<readonly NormalizedAccount[]>;
  syncBalances(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedBalance[]>;
  syncPositions(
    ctx: ConnectorContext,
    accounts: readonly NormalizedAccount[],
  ): Promise<readonly NormalizedPosition[]>;
  syncTransactions(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<{ items: readonly NormalizedTransaction[]; cursor: SyncCursor }>;
  syncIncome(
    ctx: ConnectorContext,
    window: SyncWindow,
  ): Promise<readonly NormalizedIncome[]>;
  getSyncStatus(ctx: ConnectorContext): Promise<SyncStatusReport>;
}

/* -------------------------------------------------------------- erreurs */

export class ConnectorError extends Error {
  readonly providerId: string;
  readonly kind:
    /** Identifiants absents ou refusés : l'utilisateur doit (re)saisir ses accès. */
    | 'AUTH_REQUIRED'
    /** Une validation humaine est nécessaire (TOTP, application mobile, captcha). */
    | 'MFA_REQUIRED'
    /** Session/token expiré : reconnexion nécessaire, sans ressaisie complète. */
    | 'SESSION_EXPIRED'
    /** Le fournisseur limite le débit : il faut attendre. */
    | 'RATE_LIMITED'
    /** Le fournisseur est disponible mais son comportement a changé (endpoint, format). */
    | 'PROVIDER_BROKEN'
    /** Le fournisseur est injoignable (panne, DNS, timeout). */
    | 'PROVIDER_DOWN'
    /** Erreur d'exécution de la synchronisation elle-même (écriture, cohérence). */
    | 'SYNC_ERROR'
    /** Problème réseau côté client. */
    | 'NETWORK'
    /** Données inexploitables (format, cohérence) : rien n'est deviné. */
    | 'DATA'
    /** Fonctionnalité non supportée par cette source, par conception. */
    | 'NOT_SUPPORTED';

  constructor(
    providerId: string,
    kind: ConnectorError['kind'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`[${providerId}/${kind}] ${message}`, options);
    this.name = 'ConnectorError';
    this.providerId = providerId;
    this.kind = kind;
  }

  get requiresUserAction(): boolean {
    return this.kind === 'AUTH_REQUIRED' || this.kind === 'MFA_REQUIRED';
  }

  get status(): SyncStatus {
    switch (this.kind) {
      case 'AUTH_REQUIRED':
      case 'MFA_REQUIRED':
      case 'SESSION_EXPIRED':
        return 'AUTH_REQUIRED';
      case 'NOT_SUPPORTED':
        return 'DISCONNECTED';
      default:
        return 'ERROR';
    }
  }

  /**
   * Action attendue de l'utilisateur, en clair. Sert à l'interface pour afficher
   * une consigne actionnable au lieu d'une erreur technique.
   */
  get userAction(): string | null {
    switch (this.kind) {
      case 'AUTH_REQUIRED':
        return 'Saisissez vos identifiants pour cette source.';
      case 'MFA_REQUIRED':
        return 'Validez la connexion dans l\'application du fournisseur, puis relancez la synchronisation.';
      case 'SESSION_EXPIRED':
        return 'Votre session a expiré : reconnectez-vous à cette source.';
      case 'RATE_LIMITED':
        return 'Le fournisseur limite temporairement les accès : réessayez dans quelques minutes.';
      case 'PROVIDER_DOWN':
        return 'Le service du fournisseur est injoignable : réessayez plus tard.';
      default:
        return null;
    }
  }
}

/**
 * Masque les valeurs sensibles d'un message avant journalisation.
 * Les connecteurs passent leurs erreurs HTTP par ici : un token qui apparaîtrait
 * dans une URL ou un corps de réponse ne doit jamais finir dans les logs.
 */
export function redact(input: string): string {
  return input
    .replace(/([?&](?:token|access_token|refresh_token|api_key|apikey|code|pin)=)[^&\s]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    .replace(/("(?:password|pin|token|accessToken|refreshToken|privateKey|seed)"\s*:\s*")[^"]*(")/gi, '$1***$2')
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, '0x***')
    .replace(/\b\d{6}\b(?=\s*(?:as|comme)?\s*(?:code|pin|2fa|otp))/gi, '***');
}

export interface RegistryOptions {
  readonly connectors: readonly Connector[];
}

/** Registre des connecteurs : résolution par identifiant, contrôle des doublons. */
export class ConnectorRegistry {
  readonly #byId = new Map<ProviderId, Connector>();

  constructor(connectors: readonly Connector[]) {
    for (const connector of connectors) {
      if (this.#byId.has(connector.id)) {
        throw new Error(`Connecteur en doublon pour le fournisseur ${connector.id}`);
      }
      this.#byId.set(connector.id, connector);
    }
  }

  get(id: ProviderId): Connector | null {
    return this.#byId.get(id) ?? null;
  }

  require(id: ProviderId): Connector {
    const connector = this.get(id);
    if (!connector) throw new ConnectorError(id, 'NOT_SUPPORTED', 'Connecteur non enregistré');
    return connector;
  }

  list(): readonly Connector[] {
    return [...this.#byId.values()];
  }

  /** Trouve le meilleur parser de fichier pour un contenu donné (score de détection). */
  detectImportFormat(content: string): { connector: Connector; format: ImportFormat; score: number } | null {
    let best: { connector: Connector; format: ImportFormat; score: number } | null = null;
    for (const connector of this.#byId.values()) {
      for (const format of connector.importFormats) {
        let score = 0;
        try {
          score = format.detect(content);
        } catch {
          score = 0;
        }
        if (score > (best?.score ?? 0)) best = { connector, format, score };
      }
    }
    return best && best.score > 0 ? best : null;
  }
}
