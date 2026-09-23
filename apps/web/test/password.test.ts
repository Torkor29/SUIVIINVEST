/** Indicateur de robustesse du mot de passe (aide à la saisie). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordStrength } from '../src/lib/password.ts';

test('passwordStrength : du vide au solide', () => {
  assert.equal(passwordStrength('').level, 0);
  assert.equal(passwordStrength('abc').level, 1);
  assert.equal(passwordStrength('aaaaaaaaaaaa').level, 2);
  assert.equal(passwordStrength('abcdefghijk').level, 2);
  assert.equal(passwordStrength('abcdef1234').level, 3);
  assert.equal(passwordStrength('Abcdef-12345').level, 4);
  assert.equal(passwordStrength('une phrase de passe assez longue').level, 4);
});
