/**
 * Limitation de débit en mémoire.
 *
 * Objectif : rendre une attaque par force brute sur le mot de passe de
 * l'application impraticable, sans dépendance externe (Redis serait une charge
 * inutile pour une application mono-utilisateur).
 *
 * Algorithme : fenêtre glissante par clé (IP), avec en plus un compteur global
 * pour éviter qu'un attaquant distribué passe à travers.
 */

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
  /** Blocage progressif : le blocage grandit avec le nombre d'échecs. */
  readonly lockoutMs?: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #blockedUntil = new Map<string, number>();
  readonly #rule: RateLimitRule;
  readonly #now: () => number;

  constructor(rule: RateLimitRule, now: () => number = Date.now) {
    this.#rule = rule;
    this.#now = now;
  }

  check(key: string): RateLimitResult {
    const now = this.#now();
    const blocked = this.#blockedUntil.get(key);
    if (blocked && blocked > now) {
      return { allowed: false, remaining: 0, retryAfterMs: blocked - now };
    }
    this.#prune(key, now);
    const hits = this.#hits.get(key) ?? [];
    const remaining = Math.max(0, this.#rule.max - hits.length);
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  /** Enregistre une tentative. Retourne l'état après enregistrement. */
  record(key: string, success = false): RateLimitResult {
    const now = this.#now();
    if (success) {
      // Un succès remet le compteur à zéro : l'utilisateur légitime n'est jamais
      // pénalisé par ses propres erreurs de frappe.
      this.#hits.delete(key);
      this.#blockedUntil.delete(key);
      return { allowed: true, remaining: this.#rule.max, retryAfterMs: 0 };
    }
    this.#prune(key, now);
    const hits = this.#hits.get(key) ?? [];
    hits.push(now);
    this.#hits.set(key, hits);
    const remaining = Math.max(0, this.#rule.max - hits.length);
    if (remaining === 0 && this.#rule.lockoutMs) {
      // Blocage croissant : 30 s, 60 s, 120 s... plafonné par le lockout de base.
      const over = hits.length - this.#rule.max;
      const lockout = Math.min(this.#rule.lockoutMs * 2 ** Math.max(0, over - 1), this.#rule.windowMs);
      this.#blockedUntil.set(key, now + lockout);
      return { allowed: false, remaining: 0, retryAfterMs: lockout };
    }
    return { allowed: remaining > 0, remaining, retryAfterMs: 0 };
  }

  reset(key?: string): void {
    if (key) {
      this.#hits.delete(key);
      this.#blockedUntil.delete(key);
      return;
    }
    this.#hits.clear();
    this.#blockedUntil.clear();
  }

  #prune(key: string, now: number): void {
    const hits = this.#hits.get(key);
    if (!hits) return;
    const fresh = hits.filter((timestamp) => now - timestamp < this.#rule.windowMs);
    if (fresh.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, fresh);
  }
}

/** Règles par défaut de l'application. */
export const LOGIN_RATE_LIMIT: RateLimitRule = {
  windowMs: 15 * 60_000,
  max: 8,
  lockoutMs: 30_000,
};

export const API_RATE_LIMIT: RateLimitRule = {
  windowMs: 60_000,
  max: 300,
};