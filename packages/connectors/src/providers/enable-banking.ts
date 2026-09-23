import { createPrivateKey, sign } from 'node:crypto';
import {
  ConnectorError,
  redact,
  type Connector,
  type ConnectorContext,
  type HttpClient,
  type NormalizedAccount,
  type NormalizedBalance,
  type NormalizedTransaction,
  type SecretReader,
} from '../connector.ts';

/**
 * Banques européennes via Enable Banking (open banking PSD2, API officielle).
 *
 * Enable Banking est un prestataire agréé : il sert d'intermédiaire réglementé
 * entre l'application et les API officielles des banques. Pour un usage
 * personnel, son accès « Restricted Production » est gratuit et limité aux
 * comptes que l'on relie soi-même — exactement notre cas.
 *
 * Parcours :
 *   1. l'application Enable Banking de l'utilisateur est identifiée par un
 *      identifiant et une clé privée RSA (secrets `enablebanking_application_id`
 *      et `enablebanking_private_key`) ;
 *   2. `startAuthorization` renvoie l'adresse de la banque où l'utilisateur
 *      donne son accord (lecture seule, durée limitée par la banque) ;
 *   3. la banque redirige avec un `code`, échangé contre une session
 *      (`createSession`) dont l'identifiant est stocké chiffré ;
 *   4. le connecteur lit comptes, soldes et opérations de cette session.
 *
 * Aucune route de paiement n'est appelée : seul l'accès « comptes » (AIS) est
 * demandé à la banque.
 */

export const ENABLE_BANKING_API = 'https://api.enablebanking.com';
const PROVIDER_ID = 'enable_banking';

export interface EnableBankingCredentials {
  readonly applicationId: string;
  readonly privateKey: string;
}

export interface Aspsp {
  readonly name: string;
  readonly country: string;
  readonly logo?: string;
  readonly psu_types?: readonly string[];
  readonly maximum_consent_validity?: number;
}

export interface EnableBankingSession {
  readonly session_id: string;
  readonly accounts: readonly EnableBankingAccount[];
  readonly aspsp?: { name: string; country: string };
  readonly access?: { valid_until?: string };
}

export interface EnableBankingAccount {
  readonly uid: string;
  readonly identification_hash?: string;
  readonly account_id?: { iban?: string; other?: { identification?: string } };
  readonly name?: string;
  readonly details?: string;
  readonly product?: string;
  readonly currency?: string;
  readonly cash_account_type?: string;
}

interface BalanceRow {
  readonly balance_amount: { amount: string; currency: string };
  readonly balance_type?: string;
  readonly reference_date?: string;
}

interface TransactionRow {
  readonly entry_reference?: string | null;
  readonly transaction_id?: string | null;
  readonly transaction_amount: { amount: string; currency: string };
  readonly credit_debit_indicator?: 'CRDT' | 'DBIT';
  readonly status?: string;
  readonly booking_date?: string | null;
  readonly value_date?: string | null;
  readonly transaction_date?: string | null;
  readonly remittance_information?: readonly string[] | null;
  readonly creditor?: { name?: string } | null;
  readonly debtor?: { name?: string } | null;
  readonly bank_transaction_code?: { description?: string } | null;
}

/** Signe le jeton d'accès à l'API (RS256, valable une heure). */
export function enableBankingJwt(credentials: EnableBankingCredentials, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: credentials.applicationId };
  const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  let key;
  try {
    key = createPrivateKey(credentials.privateKey.replace(/\\n/g, '\n').trim());
  } catch {
    throw new ConnectorError(
      PROVIDER_ID,
      'AUTH_REQUIRED',
      'Clé privée Enable Banking illisible : collez le fichier .pem complet (« -----BEGIN PRIVATE KEY----- »…).',
    );
  }
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

/** Client HTTP de l'API Enable Banking (utilisé par le connecteur et par les routes d'autorisation). */
export class EnableBankingClient {
  readonly #http: HttpClient;
  readonly #credentials: EnableBankingCredentials;
  readonly #now: () => Date;

  constructor(http: HttpClient, credentials: EnableBankingCredentials, now: () => Date = () => new Date()) {
    this.#http = http;
    this.#credentials = credentials;
    this.#now = now;
  }

  async #call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.#http.request(`${ENABLE_BANKING_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${enableBankingJwt(this.#credentials, this.#now())}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status >= 400) {
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(response.text) as { message?: string; detail?: unknown; error?: string };
        message = parsed.message ?? parsed.error ?? message;
      } catch {
        /* corps non JSON */
      }
      if (response.status === 422 && /session|expired|consent|revoked/i.test(message)) {
        throw new ConnectorError(PROVIDER_ID, 'SESSION_EXPIRED', `Autorisation bancaire expirée : ${message}`);
      }
      throw new ConnectorError(PROVIDER_ID, response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_BROKEN', `Enable Banking : ${redact(message)}`);
    }
    return (response.text === '' ? {} : JSON.parse(response.text)) as T;
  }

  async listAspsps(country: string): Promise<readonly Aspsp[]> {
    const result = await this.#call<{ aspsps: Aspsp[] }>('GET', `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`);
    return result.aspsps ?? [];
  }

  /** Démarre l'autorisation : renvoie l'adresse de la banque où donner son accord. */
  async startAuthorization(input: {
    readonly aspspName: string;
    readonly country: string;
    readonly redirectUrl: string;
    readonly state: string;
    readonly validUntil: Date;
  }): Promise<{ url: string; authorizationId?: string }> {
    const result = await this.#call<{ url: string; authorization_id?: string }>('POST', '/auth', {
      access: { valid_until: input.validUntil.toISOString() },
      aspsp: { name: input.aspspName, country: input.country },
      state: input.state,
      redirect_url: input.redirectUrl,
      psu_type: 'personal',
    });
    return { url: result.url, ...(result.authorization_id ? { authorizationId: result.authorization_id } : {}) };
  }

  /** Échange le code de retour contre une session d'accès aux comptes. */
  async createSession(code: string): Promise<EnableBankingSession> {
    return this.#call<EnableBankingSession>('POST', '/sessions', { code });
  }

  async getSession(sessionId: string): Promise<{
    accounts: readonly string[];
    accounts_data?: readonly { uid: string; identification_hash?: string }[];
    status?: string;
    access?: { valid_until?: string };
  }> {
    return this.#call('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.#call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async accountDetails(uid: string): Promise<EnableBankingAccount> {
    return this.#call('GET', `/accounts/${encodeURIComponent(uid)}/details`);
  }

  async balances(uid: string): Promise<readonly BalanceRow[]> {
    const result = await this.#call<{ balances: BalanceRow[] }>('GET', `/accounts/${encodeURIComponent(uid)}/balances`);
    return result.balances ?? [];
  }

  async transactions(uid: string, dateFrom: string | null): Promise<readonly TransactionRow[]> {
    const rows: TransactionRow[] = [];
    let continuation: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query = new URLSearchParams();
      if (dateFrom) query.set('date_from', dateFrom);
      if (continuation) query.set('continuation_key', continuation);
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
      const result: { transactions?: TransactionRow[]; continuation_key?: string | null } = await this.#call(
        'GET',
        `/accounts/${encodeURIComponent(uid)}/transactions${suffix}`,
      );
      rows.push(...(result.transactions ?? []));
      continuation = result.continuation_key ?? null;
      if (!continuation) break;
    }
    return rows;
  }
}

/** Lit les identifiants de l'application Enable Banking depuis les secrets. */
export async function enableBankingCredentials(secrets: SecretReader): Promise<EnableBankingCredentials> {
  const applicationId = (await secrets.get('enablebanking_application_id'))?.trim() ?? '';
  const privateKey = (await secrets.get('enablebanking_private_key'))?.trim() ?? '';
  if (applicationId === '' || privateKey === '') {
    throw new ConnectorError(
      PROVIDER_ID,
      'AUTH_REQUIRED',
      'Application Enable Banking non configurée : renseignez son identifiant et sa clé privée dans Connexions.',
    );
  }
  return { applicationId, privateKey };
}

/** Priorité des types de solde : disponible / comptable du jour d'abord. */
const BALANCE_PRIORITY = ['ITAV', 'CLAV', 'ITBD', 'CLBD', 'XPCD', 'OPAV', 'OPBD', 'PRCD', 'FWAV', 'INFO'];

export function pickBalance(rows: readonly BalanceRow[]): BalanceRow | null {
  if (rows.length === 0) return null;
  const ranked = [...rows].sort((a, b) => {
    const rankA = BALANCE_PRIORITY.indexOf(a.balance_type ?? '');
    const rankB = BALANCE_PRIORITY.indexOf(b.balance_type ?? '');
    return (rankA === -1 ? 99 : rankA) - (rankB === -1 ? 99 : rankB);
  });
  return ranked[0] ?? null;
}

/** Convertit une opération bancaire en transaction normalisée (signe selon crédit/débit). */
export function normalizeBankTransaction(accountId: string, row: TransactionRow): NormalizedTransaction | null {
  if (row.status && row.status !== 'BOOK') return null; // opérations en attente : pas encore définitives
  const raw = Number.parseFloat(row.transaction_amount.amount);
  if (!Number.isFinite(raw)) return null;
  const magnitude = Math.abs(raw);
  const credit = row.credit_debit_indicator ? row.credit_debit_indicator === 'CRDT' : raw >= 0;
  const date = (row.booking_date ?? row.value_date ?? row.transaction_date ?? '').slice(0, 10);
  if (date === '') return null;
  const counterparty = credit ? row.debtor?.name : row.creditor?.name;
  const description =
    [...(row.remittance_information ?? []), counterparty ?? '', row.bank_transaction_code?.description ?? '']
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join(' · ')
      .slice(0, 240) || (credit ? 'Crédit' : 'Débit');
  return {
    externalAccountId: accountId,
    externalTransactionId: row.entry_reference ?? row.transaction_id ?? null,
    externalAssetId: null,
    date,
    type: credit ? 'DEPOSIT' : 'WITHDRAWAL',
    description,
    quantity: null,
    unitPrice: null,
    amount: credit ? magnitude : -magnitude,
    currency: row.transaction_amount.currency,
    fees: 0,
    taxes: 0,
    rawSourceType: 'enable_banking.transaction',
  };
}

async function clientFor(ctx: ConnectorContext): Promise<{ client: EnableBankingClient; sessionId: string }> {
  const credentials = await enableBankingCredentials(ctx.secrets);
  const sessionId = (await ctx.secrets.get('enablebanking_session_id'))?.trim() ?? '';
  if (sessionId === '') {
    throw new ConnectorError(PROVIDER_ID, 'AUTH_REQUIRED', 'Banque non autorisée : lancez « Autoriser l’accès » pour cette banque.');
  }
  return { client: new EnableBankingClient(ctx.http, credentials, ctx.now), sessionId };
}

/** Identifiant stable d'un compte : empreinte fournie par Enable Banking (identique d'une session à l'autre). */
function stableAccountId(uid: string, hash: string | undefined): string {
  return `eb:${hash ?? uid}`;
}

interface SessionAccount {
  readonly uid: string;
  readonly externalAccountId: string;
}

async function sessionAccounts(ctx: ConnectorContext): Promise<{ client: EnableBankingClient; accounts: SessionAccount[] }> {
  const { client, sessionId } = await clientFor(ctx);
  const session = await client.getSession(sessionId);
  if (session.status && !['AUTHORIZED', 'AUTHORIZATION_IN_PROGRESS'].includes(session.status)) {
    throw new ConnectorError(
      PROVIDER_ID,
      'SESSION_EXPIRED',
      `Autorisation bancaire ${session.status === 'EXPIRED' ? 'expirée' : 'inactive'} : renouvelez-la depuis Connexions.`,
    );
  }
  const hashes = new Map((session.accounts_data ?? []).map((row) => [row.uid, row.identification_hash]));
  return {
    client,
    accounts: session.accounts.map((uid) => ({ uid, externalAccountId: stableAccountId(uid, hashes.get(uid)) })),
  };
}

export const enableBankingConnector: Connector = {
  id: PROVIDER_ID,
  displayName: 'Banques (open banking)',
  capabilities: { accounts: true, balances: true, positions: false, transactions: true, income: false, api: true },
  importFormats: [],
  requiredConfig: ['aspsp_name', 'aspsp_country'],
  requiredSecrets: ['enablebanking_session_id'],

  async testConnection(ctx) {
    try {
      const { accounts } = await sessionAccounts(ctx);
      return {
        ok: true,
        status: 'CONNECTED',
        message: `${ctx.config.aspsp_name ?? 'Banque'} : ${accounts.length} compte(s) accessible(s), lecture seule.`,
        requiresUserAction: false,
      };
    } catch (error) {
      if (error instanceof ConnectorError) {
        return { ok: false, status: error.status, message: error.message, requiresUserAction: true };
      }
      throw error;
    }
  },

  async syncAccounts(ctx): Promise<readonly NormalizedAccount[]> {
    const { client, accounts } = await sessionAccounts(ctx);
    const bank = ctx.config.aspsp_name ?? 'Banque';
    const result: NormalizedAccount[] = [];
    for (const account of accounts) {
      let details: EnableBankingAccount | null = null;
      try {
        details = await client.accountDetails(account.uid);
      } catch (error) {
        ctx.logger.warn(`Détail de compte indisponible : ${redact(error instanceof Error ? error.message : String(error))}`);
      }
      const iban = details?.account_id?.iban ?? '';
      const label = details?.name ?? details?.product ?? details?.details ?? 'Compte';
      result.push({
        externalAccountId: account.externalAccountId,
        // Seuls les 4 derniers chiffres de l'IBAN sont affichés : jamais l'IBAN complet.
        name: `${bank} · ${label}${iban.length > 4 ? ` ••${iban.slice(-4)}` : ''}`,
        type: 'CASH',
        currency: details?.currency ?? 'EUR',
        rawSourceType: 'enable_banking.account',
        balance: null,
        isActive: true,
      });
    }
    return result;
  },

  async syncBalances(ctx): Promise<readonly NormalizedBalance[]> {
    const { client, accounts } = await sessionAccounts(ctx);
    const date = ctx.now().toISOString().slice(0, 10);
    const balances: NormalizedBalance[] = [];
    for (const account of accounts) {
      const picked = pickBalance(await client.balances(account.uid));
      if (!picked) continue;
      const amount = Number.parseFloat(picked.balance_amount.amount);
      if (!Number.isFinite(amount)) continue;
      balances.push({
        externalAccountId: account.externalAccountId,
        date,
        cash: amount,
        currency: picked.balance_amount.currency,
        rawSourceType: `enable_banking.balance.${picked.balance_type ?? 'UNKNOWN'}`,
      });
    }
    return balances;
  },

  async syncPositions() {
    return [];
  },

  async syncTransactions(ctx, window) {
    const { client, accounts } = await sessionAccounts(ctx);
    // Première synchro : 90 jours (ce que toutes les banques acceptent) ; ensuite
    // reprise avec un recouvrement, l'idempotence évite les doublons.
    const since = window.since ?? new Date(ctx.now().getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const items: NormalizedTransaction[] = [];
    for (const account of accounts) {
      const rows = await client.transactions(account.uid, since);
      for (const row of rows) {
        const normalized = normalizeBankTransaction(account.externalAccountId, row);
        if (normalized) items.push(normalized);
      }
    }
    return { items, cursor: { value: ctx.now().toISOString().slice(0, 10) } };
  },

  async syncIncome() {
    return [];
  },

  async getSyncStatus(ctx) {
    try {
      const { client, sessionId } = await clientFor(ctx);
      const session = await client.getSession(sessionId);
      const until = session.access?.valid_until?.slice(0, 10);
      return {
        status: 'CONNECTED',
        lastSyncAt: null,
        message: until ? `Autorisation valable jusqu’au ${until}.` : 'Autorisation active.',
        requiresUserAction: false,
      };
    } catch (error) {
      if (error instanceof ConnectorError) {
        return { status: error.status, lastSyncAt: null, message: error.message, requiresUserAction: true };
      }
      throw error;
    }
  },
};
