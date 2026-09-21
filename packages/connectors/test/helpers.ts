/**
 * Outils de test partagés par les connecteurs.
 *
 * Aucun test ne doit atteindre le réseau : `makeTestContext()` monte
 * systématiquement un `FakeHttpClient` (routes scriptées) et un lecteur de
 * secrets en mémoire. Aucun identifiant réel n'est utilisé nulle part.
 */

import { readFileSync } from 'node:fs';
import {
  createTestLogger,
  FakeHttpClient,
  type Connector,
  type ConnectorContext,
  type HttpClient,
  type SecretReader,
} from '../src/index.ts';

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

export interface FakeRouteRespond {
  readonly status?: number;
  readonly text?: string;
  readonly result?: unknown;
}

export function jsonResponse(body: unknown): { status: number; headers: Record<string, string>; text: string } {
  return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) };
}

export interface TestContext {
  readonly ctx: ConnectorContext;
  readonly http: FakeHttpClient;
  readonly lines: { level: string; message: string; meta?: Record<string, unknown> }[];
  readonly userActions: string[];
}

export interface TestContextOptions {
  readonly config?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly routes?: ConstructorParameters<typeof FakeHttpClient>[0];
  readonly now?: Date;
}

export function makeTestContext(options: TestContextOptions = {}): TestContext {
  const { logger, lines } = createTestLogger();
  const http = new FakeHttpClient(options.routes ?? []);
  const secrets: Readonly<Record<string, string>> = options.secrets ?? {};
  const secretReader: SecretReader = {
    async get(name: string): Promise<string | null> {
      return secrets[name] ?? null;
    },
  };
  const userActions: string[] = [];
  const ctx: ConnectorContext = {
    connectionId: 'connection-de-test',
    syncRunId: 'run-de-test',
    config: options.config ?? {},
    secrets: secretReader,
    http: http as HttpClient,
    logger,
    now: () => options.now ?? new Date('2026-04-15T12:00:00.000Z'),
    requestUserAction: async (reason: string) => {
      userActions.push(reason);
    },
  };
  return { ctx, http, lines, userActions };
}

export function formatOf(connector: Connector, id: string) {
  const format = connector.importFormats.find((candidate) => candidate.id === id);
  if (!format) throw new Error(`Format d'import introuvable : ${id}`);
  return format;
}

/** Vérifie qu'une promesse échoue avec un `ConnectorError` du type attendu. */
export async function expectConnectorError(
  promise: Promise<unknown>,
  kind: string,
): Promise<Error & { kind?: string; providerId?: string }> {
  try {
    await promise;
  } catch (error) {
    const typed = error as Error & { kind?: string; providerId?: string };
    if (typed.kind !== kind) {
      throw new Error(`ConnectorError attendu de type ${kind}, reçu ${typed.kind ?? 'aucun'} (${typed.message})`);
    }
    return typed;
  }
  throw new Error(`Une ConnectorError de type ${kind} était attendue, mais la promesse a réussi.`);
}
