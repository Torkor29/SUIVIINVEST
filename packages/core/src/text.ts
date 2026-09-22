/**
 * Mise en forme de texte destinée à l'utilisateur.
 *
 * Règle française appliquée partout : le pluriel commence à DEUX. Zéro reste au
 * singulier (« 0 erreur », pas « 0 erreurs »), ce qui donne des messages justes
 * sans ternir la lecture (« 1 transaction récupérée », « 3 transactions récupérées »).
 *
 * ⚠️ Ce module est le seul du paquet importable par le NAVIGATEUR
 * (`@suiviinvest/core/text`) : le reste de `core` (déduplication par empreinte)
 * dépend de `node:crypto` et n'a rien à faire dans un bundle web.
 */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
