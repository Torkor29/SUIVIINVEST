import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type ImportFormat,
  type NormalizedAccount,
  type NormalizedPosition,
  type NormalizedTransaction,
} from '@suiviinvest/connectors';
import type { AccountType, ProviderId } from '@suiviinvest/core';

/**
 * Connecteurs FACTICES pour les tests de bout en bout.
 *
 * ⚠️ Ils ne contactent aucun service réel et ne doivent **jamais** être activés en
 * production : `buildApp` refuse de les utiliser si `NODE_ENV === 'production'`.
 * Ils existent pour que Playwright puisse exercer les parcours complets (ajout de
 * wallet, synchronisation, positions, patrimoine, imports) sans réseau ni
 * identifiants, et de façon déterministe.
 *
 * Le comportement de chaque doublure est calqué sur le contrat réel du connecteur
 * correspondant : mêmes DTO normalisés, mêmes codes d'erreur.
 */

interface FakeSpec {
  readonly id: ProviderId;
  readonly label: string;
  readonly accounts: readonly NormalizedAccount[];
  readonly positions: readonly NormalizedPosition[];
  readonly transactions: readonly NormalizedTransaction[];
  /** Comportement du test de connexion : succès, MFA requise, ou erreur. */
  readonly behavior?: 'OK' | 'MFA' | 'SESSION_EXPIRED' | 'PROVIDER_DOWN';
}

const TODAY = '2026-09-21';

/**
 * Format d'import CSV des doublures E2E.
 *
 * Il reproduit le strict nécessaire d'un relevé : entête
 * `date;type;description;amount;currency`, séparateur point-virgule. Le
 * suffixe `-generic-csv` le rend éligible au repli de l'analyse d'import, ce qui
 * permet à Playwright de couvrir le parcours d'import sans dépendre d'un
 * fournisseur réel.
 */
const E2E_CSV_FORMAT: ImportFormat = {
  id: 'e2e-generic-csv',
  label: 'Relevé CSV (données de test)',
  kind: 'CSV',
  detect(content: string): number {
    const header = (content.split(/\r?\n/)[0] ?? '').toLowerCase();
    const hasDate = header.includes('date');
    const hasAmount = header.includes('amount') || header.includes('montant');
    return hasDate && hasAmount ? 0.9 : 0;
  },
  parse(content: string) {
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
    const header = (lines[0] ?? '').split(';').map((cell) => cell.trim().toLowerCase());
    const indexOf = (name: string): number => header.indexOf(name);
    const cell = (cells: readonly string[], name: string): string => {
      const index = indexOf(name);
      return index >= 0 ? (cells[index] ?? '').trim() : '';
    };
    const numberOrNull = (raw: string): number | null => {
      if (raw === '') return null;
      const parsed = Number.parseFloat(raw.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    };

    const transactions: NormalizedTransaction[] = [];
    const errors: { line: number; reason: string }[] = [];

    for (let index = 1; index < lines.length; index += 1) {
      const cells = (lines[index] ?? '').split(';');
      const date = cell(cells, 'date');
      const amount = numberOrNull(cell(cells, 'amount') || cell(cells, 'montant'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount === null) {
        errors.push({ line: index + 1, reason: 'date ou montant illisible' });
        continue;
      }
      const rawType = (cell(cells, 'type') || 'ACHAT').toUpperCase();
      const type =
        rawType === 'DIVIDENDE' || rawType === 'DIVIDEND'
          ? 'DIVIDEND'
          : rawType === 'ACHAT' || rawType === 'BUY'
            ? 'BUY'
            : rawType === 'VENTE' || rawType === 'SELL'
              ? 'SELL'
              : 'DEPOSIT';
      const isin = cell(cells, 'isin') || null;
      transactions.push({
        externalAccountId: cell(cells, 'account') || 'E2E-IMPORT',
        externalTransactionId: cell(cells, 'id') || null,
        externalAssetId: isin,
        date,
        type,
        description: cell(cells, 'description') || type,
        quantity: numberOrNull(cell(cells, 'quantity')),
        unitPrice: numberOrNull(cell(cells, 'unit_price')),
        amount,
        currency: (cell(cells, 'currency') || 'EUR').toUpperCase(),
        fees: 0,
        taxes: 0,
        rawSourceType: 'E2E',
      });
    }

    return {
      transactions,
      income: [],
      positions: [],
      detectedColumns: header,
      unmappedColumns: [],
      warnings: [],
      errors,
    };
  },
};

function spec(input: FakeSpec): Connector {
  return {
    id: input.id,
    displayName: input.label,
    capabilities: {
      accounts: true,
      balances: true,
      positions: true,
      transactions: true,
      income: true,
      api: true,
    },
    // Le format CSV de test, partagé par toutes les doublures.
    importFormats: [E2E_CSV_FORMAT],
    requiredConfig: [],
    requiredSecrets: [],
    async testConnection() {
      switch (input.behavior) {
        case 'MFA':
          return {
            ok: false,
            status: 'AUTH_REQUIRED',
            message: 'Validation requise dans l\'application du fournisseur (données de test).',
            requiresUserAction: true,
          };
        case 'SESSION_EXPIRED':
          return { ok: false, status: 'AUTH_REQUIRED', message: 'Session expirée (données de test).' };
        case 'PROVIDER_DOWN':
          return { ok: false, status: 'ERROR', message: 'Service injoignable (données de test).' };
        default:
          return { ok: true, status: 'CONNECTED', message: 'Connexion factice OK.' };
      }
    },
    async syncAccounts() {
      if (input.behavior === 'MFA') {
        throw new ConnectorError(input.id, 'MFA_REQUIRED', 'Validation requise dans l\'application.');
      }
      if (input.behavior === 'SESSION_EXPIRED') {
        throw new ConnectorError(input.id, 'SESSION_EXPIRED', 'Session expirée.');
      }
      if (input.behavior === 'PROVIDER_DOWN') {
        throw new ConnectorError(input.id, 'PROVIDER_DOWN', 'Service injoignable.');
      }
      return input.accounts;
    },
    async syncBalances(_ctx: ConnectorContext, accounts) {
      return accounts.map((account) => ({
        externalAccountId: account.externalAccountId,
        date: TODAY,
        cash: 1000,
        currency: account.currency,
        rawSourceType: 'E2E',
      }));
    },
    async syncPositions() {
      return input.positions;
    },
    async syncTransactions() {
      return { items: input.transactions, cursor: { value: null } };
    },
    async syncIncome() {
      return [];
    },
    async getSyncStatus() {
      return { status: 'SYNCED', lastSyncAt: TODAY, message: 'données de test', requiresUserAction: false };
    },
  };
}

const account = (
  externalAccountId: string,
  name: string,
  type: AccountType,
  currency = 'EUR',
): NormalizedAccount => ({
  externalAccountId,
  name,
  type,
  currency,
  rawSourceType: 'E2E',
});

const buy = (
  externalAccountId: string,
  isin: string,
  date: string,
  quantity: number,
  unitPrice: number,
  externalTransactionId: string,
): NormalizedTransaction => ({
  externalAccountId,
  externalTransactionId,
  externalAssetId: isin,
  date,
  type: 'BUY',
  description: `Achat ${isin}`,
  quantity,
  unitPrice,
  amount: -(quantity * unitPrice),
  currency: 'EUR',
  fees: 0,
  taxes: 0,
  rawSourceType: 'E2E',
});

/** Jeu de connecteurs factices : un par fournisseur, comportements distincts. */
export function createE2eConnectors(): Connector[] {
  return [
    spec({
      id: 'metamask',
      label: 'Wallet EVM (MetaMask)',
      accounts: [account('0xe2e0000000000000000000000000000000000001', 'Wallet E2E', 'CRYPTO')],
      positions: [
        {
          externalAccountId: '0xe2e0000000000000000000000000000000000001',
          externalAssetId: null,
          isin: null,
          symbol: 'ETH',
          name: 'Ether',
          kind: 'CRYPTO',
          quantity: 2,
          unitPrice: 2500,
          currency: 'EUR',
          chain: 'ethereum',
          contractAddress: null,
          decimals: 18,
          rawSourceType: 'E2E',
        },
        {
          externalAccountId: '0xe2e0000000000000000000000000000000000001',
          externalAssetId: '0xtoken00000000000000000000000000000000001',
          isin: null,
          symbol: 'USDC',
          name: 'USD Coin',
          kind: 'CRYPTO',
          quantity: 1500,
          unitPrice: 1,
          currency: 'EUR',
          chain: 'base',
          contractAddress: '0xtoken00000000000000000000000000000000001',
          decimals: 6,
          rawSourceType: 'E2E',
        },
      ],
      transactions: [
        {
          externalAccountId: '0xe2e0000000000000000000000000000000000001',
          externalTransactionId: '0xhash-e2e-1',
          externalAssetId: null,
          date: '2026-09-01',
          type: 'CRYPTO_TRANSFER',
          description: 'Transfert entrant 1 ETH',
          quantity: 1,
          unitPrice: 2400,
          amount: 2400,
          currency: 'EUR',
          fees: 0.001,
          taxes: 0,
          rawSourceType: 'E2E',
        },
      ],
    }),
    spec({
      id: 'degiro',
      label: 'DEGIRO',
      accounts: [account('E2E-DEGIRO-1', 'Compte-titres DEGIRO', 'SECURITIES')],
      positions: [
        {
          externalAccountId: 'E2E-DEGIRO-1',
          externalAssetId: 'FR0000120271',
          isin: 'FR0000120271',
          symbol: 'TTE',
          name: 'TotalEnergies',
          kind: 'EQUITY',
          quantity: 100,
          unitPrice: 58.4,
          currency: 'EUR',
          rawSourceType: 'E2E',
        },
      ],
      transactions: [
        buy('E2E-DEGIRO-1', 'FR0000120271', '2026-03-10', 100, 50, 'E2E-DEG-1'),
        {
          externalAccountId: 'E2E-DEGIRO-1',
          externalTransactionId: 'E2E-DEG-2',
          externalAssetId: 'FR0000120271',
          date: '2026-06-15',
          type: 'DIVIDEND',
          description: 'Dividende TotalEnergies',
          quantity: null,
          unitPrice: null,
          amount: 85,
          currency: 'EUR',
          fees: 0,
          taxes: 12,
          rawSourceType: 'E2E',
        },
      ],
    }),
    spec({
      id: 'trade_republic',
      label: 'Trade Republic',
      behavior: 'MFA',
      accounts: [account('E2E-TR-1', 'Portefeuille Trade Republic', 'SECURITIES')],
      positions: [],
      transactions: [],
    }),
    spec({
      id: 'credit_agricole',
      label: 'Crédit Agricole',
      accounts: [account('E2E-CA-1', 'PEA Crédit Agricole', 'SECURITIES')],
      positions: [
        {
          externalAccountId: 'E2E-CA-1',
          externalAssetId: 'FR0000000003',
          isin: 'FR0000000003',
          symbol: 'CW8',
          name: 'ETF Monde',
          kind: 'ETF',
          quantity: 40,
          unitPrice: 620,
          currency: 'EUR',
          rawSourceType: 'E2E',
        },
      ],
      transactions: [buy('E2E-CA-1', 'FR0000000003', '2026-02-01', 40, 600, 'E2E-CA-1')],
    }),
    spec({
      id: 'revolut',
      label: 'Revolut',
      accounts: [account('E2E-REV-1', 'Revolut EUR', 'CASH')],
      positions: [],
      transactions: [
        {
          externalAccountId: 'E2E-REV-1',
          externalTransactionId: 'E2E-REV-1',
          externalAssetId: null,
          date: '2026-08-01',
          type: 'BANK_EXPENSE',
          description: 'Carte BOULANGERIE',
          quantity: null,
          unitPrice: null,
          amount: -12.5,
          currency: 'EUR',
          fees: 0,
          taxes: 0,
          rawSourceType: 'E2E',
        },
      ],
    }),
  ];
}