import { DedupIndex, externalDedupKey, fingerprint, plural } from '@suiviinvest/core';
import type {
  ImportAnalyzeRequest,
  ImportAnalyzeResponse,
  ImportCommitRequest,
  ImportCommitResponse,
  ImportHistoryDto,
  ImportPreviewRow,
} from '@suiviinvest/api-contract';
import {
  ConnectorRegistry,
  type ImportFormat,
  type ImportParseResult,
  type NormalizedTransaction,
} from '@suiviinvest/connectors';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { AccountRepository } from '../repositories/accounts.ts';
import { ActivityRepository } from '../repositories/activities.ts';
import { ConnectionRepository, ImportRepository } from '../repositories/connections.ts';
import { IngestService, isoDay } from './ingest.ts';

/**
 * Moteur d'import de fichiers : fonctionnalité de premier niveau, pas un
 * bricolage annexe.
 *
 * Déroulé : analyse (détection de format, mapping, aperçu, doublons) puis
 * validation explicite avant écriture. Le même fichier importé deux fois ne
 * produit JAMAIS de doublon : la déduplication utilise les identifiants externes
 * présents dans l'export, et à défaut l'empreinte déterministe.
 */

export interface ImportServiceOptions {
  readonly baseCurrency: string;
  readonly registry: ConnectorRegistry;
}

export class ImportService {
  readonly #registry: ConnectorRegistry;
  readonly #accounts: AccountRepository;
  readonly #activities: ActivityRepository;
  readonly #imports: ImportRepository;
  readonly #connections: ConnectionRepository;
  readonly #ingest: IngestService;
  readonly #baseCurrency: string;

  constructor(db: Db, options: ImportServiceOptions) {
    this.#registry = options.registry;
    this.#accounts = new AccountRepository(db);
    this.#activities = new ActivityRepository(db);
    this.#imports = new ImportRepository(db);
    this.#connections = new ConnectionRepository(db);
    this.#ingest = new IngestService(db);
    this.#baseCurrency = options.baseCurrency;
  }

  /** Étape 1 : analyse sans écriture. L'utilisateur voit ce qui sera importé. */
  analyze(request: ImportAnalyzeRequest): ImportAnalyzeResponse {
    const resolution = this.#resolveFormat(request);
    if (!resolution) {
      return {
        detectedFormatId: null,
        detectedFormatLabel: null,
        detectionScore: 0,
        availableFormats: [],
        columns: [],
        suggestedMap: {},
        unmappedColumns: [],
        rows: [],
        summary: {
          parsed: 0,
          new: 0,
          duplicates: 0,
          errors: 1,
          dateRange: { from: null, to: null },
          currencies: [],
          totalAmount: 0,
        },
        warnings: [
          'Format non reconnu. Choisissez explicitement un format d\'import ou un mapping de colonnes.',
        ],
      };
    }

    const { connector, format, score } = resolution;
    const parsed = format.parse(request.content, {
      ...(request.columnMap ? { columnMap: request.columnMap } : {}),
      ...(request.accountId ? { defaultAccountExternalId: request.accountId } : {}),
    });

    // Un compte cible est nécessaire pour calculer la déduplication : on prend
    // celui demandé, sinon le premier compte du fournisseur concerné.
    const account = request.accountId
      ? this.#accounts.get(request.accountId)
      : this.#accounts.list().find((row) => row.provider_id === connector.id) ?? null;

    const dedup = this.#buildDedupIndex(account?.id ?? null, connector.id);
    const rows: ImportPreviewRow[] = [];
    let duplicates = 0;
    let errors = 0;
    let newCount = 0;
    let totalAmount = 0;
    const currencies = new Set<string>();
    let from: string | null = null;
    let to: string | null = null;

    for (const transaction of parsed.transactions) {
      const decision = account
        ? dedup.check({
            providerId: connector.id,
            externalAccountId: transaction.externalAccountId,
            externalTransactionId: transaction.externalTransactionId,
            accountId: account.id,
            type: transaction.type,
            date: transaction.date,
            instrumentId: transaction.externalAssetId,
            quantity: transaction.quantity,
            unitPrice: transaction.unitPrice,
            amount: transaction.amount,
            currency: transaction.currency,
            description: transaction.description,
          })
        : { decision: 'NEW' as const };
      const status: ImportPreviewRow['status'] =
        decision.decision === 'NEW' ? 'NEW' : decision.decision;
      if (status === 'NEW') newCount++;
      else duplicates++;
      currencies.add(transaction.currency);
      totalAmount += transaction.amount;
      if (!from || transaction.date < from) from = transaction.date;
      if (!to || transaction.date > to) to = transaction.date;
      rows.push({
        line: rows.length + 2,
        date: transaction.date,
        type: transaction.type,
        description: transaction.description,
        amount: transaction.amount,
        currency: transaction.currency,
        quantity: transaction.quantity,
        unitPrice: transaction.unitPrice,
        isin: transaction.externalAssetId,
        status,
        reason: null,
      });
    }

    for (const error of parsed.errors) {
      errors++;
      rows.push({
        line: error.line,
        date: null,
        type: null,
        description: '',
        amount: null,
        currency: null,
        quantity: null,
        unitPrice: null,
        isin: null,
        status: 'ERROR',
        reason: error.reason,
      });
    }

    const warnings = [...parsed.warnings];
    if (!account) {
      warnings.push(
        'Aucun compte cible : la détection des doublons ne sera appliquée qu\'au moment de l\'import définitif.',
      );
    }
    if (parsed.unmappedColumns.length > 0) {
      warnings.push(`Colonnes non utilisées : ${parsed.unmappedColumns.join(', ')}.`);
    }

    return {
      detectedFormatId: format.id,
      detectedFormatLabel: format.label,
      detectionScore: score,
      availableFormats: this.#availableFormats(request.content),
      columns: parsed.detectedColumns,
      suggestedMap: request.columnMap ?? {},
      unmappedColumns: parsed.unmappedColumns,
      rows: rows.slice(0, 200),
      summary: {
        parsed: parsed.transactions.length + parsed.errors.length,
        new: newCount,
        duplicates,
        errors,
        dateRange: { from, to },
        currencies: [...currencies],
        totalAmount: Math.round(totalAmount * 100) / 100,
      },
      warnings,
    };
  }

  /** Étape 2 : import définitif, transactionnel et idempotent. */
  commit(request: ImportCommitRequest): ImportCommitResponse {
    const importId = randomUUID();
    const resolution = this.#resolveFormat(request);
    if (!resolution) {
      return {
        importId,
        created: 0,
        skipped: 0,
        errors: 1,
        message: 'Format non reconnu : aucun import effectué.',
      };
    }
    const { connector, format } = resolution;
    const parsed = format.parse(request.content, {
      ...(request.columnMap ? { columnMap: request.columnMap } : {}),
      ...(request.accountId ? { defaultAccountExternalId: request.accountId } : {}),
    });

    const account = request.accountId ? this.#accounts.get(request.accountId) : null;
    if (!account) {
      return {
        importId,
        created: 0,
        skipped: 0,
        errors: 1,
        message: 'Compte cible introuvable : sélectionnez un compte avant d\'importer.',
      };
    }

    const connection = request.connectionId ? this.#connections.get(request.connectionId) : null;
    const report = this.#ingest.ingestImport(
      { transactions: parsed.transactions, income: parsed.income, positions: parsed.positions },
      {
        providerId: connector.id,
        connectionId: connection?.id ?? null,
        syncRunId: null,
        importId,
        baseCurrency: this.#baseCurrency,
        trigger: 'IMPORT',
        now: new Date(),
        // L'utilisateur a choisi le compte : c'est lui la destination, même si le
        // fichier porte un identifiant de compte externe différent.
        accountIdOverride: account.id,
      },
    );

    if (!request.dryRun) {
      this.#imports.record({
        importId,
        filename: request.filename,
        formatId: format.id,
        accountId: account.id,
        connectionId: connection?.id ?? null,
        created: report.created,
        skipped: report.skipped,
        errors: report.errors + parsed.errors.length,
        details: { warnings: report.warnings, parseErrors: parsed.errors },
      });
    }

    return {
      importId,
      created: report.created,
      skipped: report.skipped,
      errors: report.errors + parsed.errors.length,
      message: request.dryRun
        ? 'Simulation terminée : aucune écriture effectuée.'
        : `${plural(report.created, 'ligne importée', 'lignes importées')}, ` +
          `${plural(report.skipped, 'ignorée', 'ignorées')} (déjà présentes).`,
    };
  }

  history(): ImportHistoryDto[] {
    return this.#imports.list().map((row) => ({
      importId: row.import_id,
      filename: row.filename,
      formatId: row.format_id,
      accountId: row.account_id,
      importedAt: row.imported_at,
      created: row.created,
      skipped: row.skipped,
      errors: row.errors,
    }));
  }

  /** Formats disponibles pour un contenu donné, triés par score de détection. */
  #availableFormats(content: string): ImportAnalyzeResponse['availableFormats'] {
    const list: { id: string; label: string; providerId: string; score: number }[] = [];
    for (const connector of this.#registry.list()) {
      for (const format of connector.importFormats) {
        let score = 0;
        try {
          score = format.detect(content);
        } catch {
          score = 0;
        }
        list.push({ id: format.id, label: format.label, providerId: connector.id, score });
      }
    }
    return list.sort((a, b) => b.score - a.score);
  }

  #resolveFormat(
    request: ImportAnalyzeRequest,
  ): { connector: import('@suiviinvest/connectors').Connector; format: ImportFormat; score: number } | null {
    if (request.forceFormatId) {
      for (const connector of this.#registry.list()) {
        const format = connector.importFormats.find((candidate) => candidate.id === request.forceFormatId);
        if (format) return { connector, format, score: 1 };
      }
      return null;
    }
    const detected = this.#registry.detectImportFormat(request.content);
    if (detected && detected.score >= 0.4) return detected;
    // Aucune détection fiable : on retombe sur le format générique s'il existe.
    for (const connector of this.#registry.list()) {
      const generic = connector.importFormats.find((format) => format.id.endsWith('generic-csv'));
      if (generic) return { connector, format: generic, score: 0.2 };
    }
    return detected;
  }

  /** Index de déduplication préchargé avec ce qui est déjà en base. */
  #buildDedupIndex(accountId: string | null, providerId: string): DedupIndex {
    const index = new DedupIndex();
    const rows = accountId
      ? this.#activities.listForAccount(accountId)
      : this.#activities.listAll();
    for (const row of rows) {
      index.seed(
        externalDedupKey({
          providerId: row.provider_id,
          externalAccountId: row.external_account_id,
          externalTransactionId: row.external_transaction_id,
        }),
        row.external_transaction_id ? null : row.dedup_hash,
      );
    }
    void providerId;
    return index;
  }
}

/** Empreinte d'un lot d'import : permet d'identifier un fichier déjà traité. */
export function importFileFingerprint(filename: string, created: number, checksum: string): string {
  return fingerprint({
    providerId: 'csv',
    accountId: 'import',
    type: 'VALUATION_UPDATE',
    date: isoDay(new Date()),
    amount: created,
    currency: 'EUR',
    description: `${filename}|${checksum}`,
  });
}

export type { ImportParseResult, NormalizedTransaction };