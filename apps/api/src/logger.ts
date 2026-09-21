import { scrub } from './security/crypto.ts';
import type { Logger } from '@suiviinvest/connectors';

/**
 * Journalisation structurée (une ligne JSON par événement).
 *
 * Règle non négociable : on ne journalise JAMAIS de secret, de jeton, de cookie,
 * de PIN ni de clé privée. `scrub()` masque récursivement toute clé ressemblant
 * à un secret avant écriture, y compris si un appelant l'a oublié.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly [key: string]: unknown;
}

export function createLogger(options: {
  level: LogLevel;
  sink?: (record: LogRecord) => void;
  base?: Record<string, unknown>;
}): Logger & { lines: LogRecord[] } {
  const threshold = LEVELS[options.level];
  const lines: LogRecord[] = [];
  const sink =
    options.sink ??
    ((record: LogRecord) => {
      lines.push(record);
      const stream = record.level === 'error' || record.level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${JSON.stringify(record)}\n`);
    });

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...(options.base ?? {}),
      ...(meta ? (scrub(meta) as Record<string, unknown>) : {}),
    };
    sink(record);
  };

  return {
    lines,
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}

/** Journal silencieux pour les tests. */
export function createSilentLogger(): Logger & { lines: LogRecord[] } {
  return createLogger({ level: 'error', sink: () => undefined });
}