import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from './database.ts';

/**
 * Espaces séparés : une base SQLite par espace.
 *
 *  - l'espace « main » est la base principale (celle d'avant : le propriétaire
 *    de l'installation et les membres qu'il a invités y partagent le patrimoine) ;
 *  - chaque personne qui s'inscrit elle-même reçoit son propre fichier
 *    (`<répertoire>/<id>.db`), avec le schéma complet.
 *
 * Les services métier reçoivent une base « aiguilleuse » : chaque requête SQL
 * part vers la base de l'espace de la requête HTTP en cours (ou de la tâche
 * planifiée en cours). Sans espace défini, elle ÉCHOUE : aucune requête ne peut
 * tomber par défaut dans les données de quelqu'un d'autre. L'isolement ne
 * dépend donc d'aucun filtre oublié dans une requête.
 */

export const MAIN_TENANT = 'main';
const TENANT_ID = /^[A-Za-z0-9_-]{8,64}$/;

interface TenantStore {
  tenantId: string | null;
  db: Db | null;
}

const storage = new AsyncLocalStorage<TenantStore>();

export class TenantRegistry {
  readonly #main: Db;
  readonly #directory: string;
  readonly #open = new Map<string, Db>();

  constructor(main: Db, directory: string) {
    this.#main = main;
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  /** Base d'un espace ; créée et migrée à la première ouverture. */
  open(tenantId: string): Db {
    if (tenantId === MAIN_TENANT) return this.#main;
    if (!TENANT_ID.test(tenantId)) throw new Error('Espace invalide.');
    const cached = this.#open.get(tenantId);
    if (cached) return cached;
    if (!existsSync(this.#directory)) mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const db = new Db(join(this.#directory, `${tenantId}.db`));
    db.migrate();
    this.#open.set(tenantId, db);
    return db;
  }

  /** Tous les espaces existants (tâches planifiées, sauvegardes). */
  list(): string[] {
    const ids = [MAIN_TENANT];
    if (existsSync(this.#directory)) {
      for (const file of readdirSync(this.#directory)) {
        const match = /^(.+)\.db$/.exec(file);
        if (match && TENANT_ID.test(match[1] as string)) ids.push(match[1] as string);
      }
    }
    return ids;
  }

  closeAll(): void {
    for (const db of this.#open.values()) {
      try {
        db.close();
      } catch {
        // déjà fermée
      }
    }
    this.#open.clear();
  }
}

/** Ouvre un contexte vide (début de requête HTTP) ; l'espace est choisi après l'authentification. */
export function enterRequestScope(next: () => void): void {
  storage.run({ tenantId: null, db: null }, next);
}

/** Choisit l'espace de la requête en cours (après authentification). */
export function selectTenant(registry: TenantRegistry, tenantId: string): void {
  const store = storage.getStore();
  if (!store) throw new Error('Aucun contexte de requête : espace impossible à choisir.');
  store.tenantId = tenantId;
  store.db = registry.open(tenantId);
}

/** Exécute une tâche (planifiée, démarrage) dans un espace donné. */
export function runInTenant<T>(registry: TenantRegistry, tenantId: string, work: () => T): T {
  return storage.run({ tenantId, db: registry.open(tenantId) }, work);
}

/** Exécute une tâche pour chaque espace, l'un après l'autre ; une erreur n'arrête pas les suivants. */
export async function forEachTenant(
  registry: TenantRegistry,
  work: (tenantId: string) => Promise<void> | void,
  onError?: (tenantId: string, error: unknown) => void,
): Promise<void> {
  for (const tenantId of registry.list()) {
    try {
      await runInTenant(registry, tenantId, () => work(tenantId));
    } catch (error) {
      onError?.(tenantId, error);
    }
  }
}

export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

function currentDb(): Db {
  const db = storage.getStore()?.db;
  if (!db) {
    throw new Error('Accès aux données sans espace défini (requête non authentifiée ou tâche hors contexte).');
  }
  return db;
}

/**
 * Base aiguilleuse : même interface que `Db`, chaque appel est transmis à la
 * base de l'espace courant.
 */
export function createTenantDb(): Db {
  return new Proxy({} as Db, {
    get(_target, property) {
      const db = currentDb();
      const value = Reflect.get(db, property, db) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(db) : value;
    },
  });
}
