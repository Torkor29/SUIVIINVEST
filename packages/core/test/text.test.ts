import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plural } from '../src/text.ts';

/**
 * Mise en forme des messages : la règle française du pluriel (à partir de deux).
 * Elle est partagée par l'API et l'interface pour que « 0 erreur » et
 * « 3 erreurs » s'écrivent pareil partout.
 */
test('le pluriel commence à deux', () => {
  assert.equal(plural(0, 'erreur', 'erreurs'), '0 erreur');
  assert.equal(plural(1, 'erreur', 'erreurs'), '1 erreur');
  assert.equal(plural(2, 'erreur', 'erreurs'), '2 erreurs');
  assert.equal(plural(37, 'transaction récupérée', 'transactions récupérées'), '37 transactions récupérées');
});

test('les formes irrégulières passent par les deux libellés fournis', () => {
  assert.equal(plural(1, 'ligne importée', 'lignes importées'), '1 ligne importée');
  assert.equal(plural(2, 'ligne importée', 'lignes importées'), '2 lignes importées');
});
