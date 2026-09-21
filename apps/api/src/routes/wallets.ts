/**
 * Routes des wallets EVM.
 *
 *  - `GET  /api/wallets`                    : liste des `WalletStatusDto` ;
 *  - `POST /api/wallets/:accountId/resync`  : relance la synchronisation de ce
 *    wallet via `SyncService` (aucun ordre, aucune signature) et renvoie le
 *    résultat + l'état à jour (`WalletResyncResponse`).
 *
 * Enregistrée par l'agent principal dans `app.ts` via `registerWalletRoutes`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SyncOutcomeDto, WalletResyncResponse, WalletStatusDto } from '@suiviinvest/api-contract';
import type { Db } from '../db/database.ts';
import { AccountRepository } from '../repositories/accounts.ts';
import { SyncRunRepository } from '../repositories/connections.ts';
import { WalletStatusService } from '../services/evm/wallet-status.ts';
import type { SyncService } from '../services/sync.ts';
import { sendError } from './auth.ts';

export interface WalletRoutesDeps {
  readonly db: Db;
  readonly sync: SyncService;
  /** Injectable pour les tests ; sinon construit à la volée. */
  readonly walletStatus?: WalletStatusService;
}

export async function registerWalletRoutes(app: FastifyInstance, deps: WalletRoutesDeps): Promise<void> {
  const statuses = deps.walletStatus ?? new WalletStatusService(deps.db);
  const accounts = new AccountRepository(deps.db);
  const runs = new SyncRunRepository(deps.db);

  app.get('/api/wallets', async (_request, reply) => {
    const wallets: WalletStatusDto[] = statuses.list();
    return reply.send(wallets);
  });

  app.post('/api/wallets/:accountId/resync', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.string() }).parse(request.params);

    const account = accounts.get(accountId);
    if (!account) {
      return sendError(reply, 404, 'NOT_FOUND', 'Wallet introuvable.');
    }
    if (account.type !== 'CRYPTO') {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Ce compte n’est pas un wallet.');
    }
    if (!account.connection_id) {
      return sendError(
        reply,
        409,
        'CONFLICT',
        'Ce wallet n’est rattaché à aucune connexion : recréez la connexion pour pouvoir le synchroniser.',
      );
    }

    let outcome;
    try {
      outcome = await deps.sync.syncConnection(account.connection_id, 'MANUAL');
    } catch (error) {
      // Erreur inattendue : message propre, jamais de trace technique.
      request.log.error?.(error);
      return sendError(reply, 500, 'INTERNAL', 'La synchronisation du wallet n’a pas pu démarrer.');
    }

    const run = runs.get(outcome.syncRunId);
    const dto: SyncOutcomeDto = {
      syncRunId: outcome.syncRunId,
      connectionId: outcome.connectionId,
      providerId: outcome.providerId,
      status: outcome.status,
      created: outcome.created,
      updated: outcome.updated,
      skipped: outcome.skipped,
      errors: outcome.errors,
      message: outcome.message,
      errorCode: run?.error_code ?? null,
      durationMs: outcome.durationMs,
      warnings: outcome.warnings,
    };

    const wallet = statuses.forAccount(accountId);
    if (!wallet) {
      return sendError(reply, 404, 'NOT_FOUND', 'Wallet introuvable après synchronisation.');
    }

    const response: WalletResyncResponse = { outcome: dto, wallet };
    return reply.send(response);
  });
}
