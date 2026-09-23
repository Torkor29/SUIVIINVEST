/**
 * Banques via Enable Banking (open banking PSD2). Réponses simulées : aucun
 * appel réseau, aucune banque réelle.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { enableBankingConnector } from '../src/index.ts';
import { enableBankingJwt, normalizeBankTransaction, pickBalance } from '../src/providers/enable-banking.ts';
import { jsonResponse, makeTestContext } from './helpers.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APP = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

test('JWT RS256 signé avec la clé de l’application', () => {
  const jwt = enableBankingJwt({ applicationId: APP, privateKey: PEM }, new Date('2026-09-23T10:00:00Z'));
  const [header, payload, signature] = jwt.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'RS256', kid: APP });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
  assert.equal(claims.aud, 'api.enablebanking.com');
  assert.equal((claims.exp as number) - (claims.iat as number), 3600);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  assert.throws(() => enableBankingJwt({ applicationId: APP, privateKey: 'pas une clé' }, new Date()), /illisible/);
});

test('choix du solde et normalisation des opérations', () => {
  const picked = pickBalance([
    { balance_amount: { amount: '10', currency: 'EUR' }, balance_type: 'XPCD' },
    { balance_amount: { amount: '12.34', currency: 'EUR' }, balance_type: 'CLBD' },
  ]);
  assert.equal(picked?.balance_amount.amount, '12.34');

  const debit = normalizeBankTransaction('eb:1', {
    entry_reference: 'ref-1',
    transaction_amount: { amount: '42.50', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-09-20',
    remittance_information: ['CB CARREFOUR 19/09'],
    creditor: { name: 'Carrefour' },
  });
  assert.equal(debit?.amount, -42.5);
  assert.equal(debit?.type, 'WITHDRAWAL');
  assert.equal(debit?.description, 'CB CARREFOUR 19/09 · Carrefour');
  assert.equal(debit?.externalTransactionId, 'ref-1');

  const credit = normalizeBankTransaction('eb:1', {
    transaction_amount: { amount: '2100', currency: 'EUR' },
    credit_debit_indicator: 'CRDT',
    booking_date: '2026-09-01',
    debtor: { name: 'Employeur SA' },
  });
  assert.equal(credit?.amount, 2100);
  assert.equal(credit?.type, 'DEPOSIT');

  // Opération en attente : ignorée tant qu'elle n'est pas comptabilisée.
  assert.equal(
    normalizeBankTransaction('eb:1', {
      transaction_amount: { amount: '5', currency: 'EUR' },
      credit_debit_indicator: 'DBIT',
      status: 'PDNG',
      booking_date: '2026-09-22',
    }),
    null,
  );
});

test('synchro complète : comptes (IBAN masqué), soldes, opérations paginées', async () => {
  const { ctx, http } = makeTestContext({
    config: { aspsp_name: 'Crédit Agricole', aspsp_country: 'FR' },
    secrets: { enablebanking_application_id: APP, enablebanking_private_key: PEM, enablebanking_session_id: 'session-1' },
    now: new Date('2026-09-23T10:00:00Z'),
    routes: [
      {
        match: /\/sessions\/session-1$/,
        respond: jsonResponse({ status: 'AUTHORIZED', accounts: ['uid-a'], accounts_data: [{ uid: 'uid-a', identification_hash: 'hash-stable' }] }),
      },
      {
        match: /\/accounts\/uid-a\/details/,
        respond: { account_id: { iban: 'FR7612345678901234567890123' }, name: 'Compte courant', currency: 'EUR' },
      },
      {
        match: /\/accounts\/uid-a\/balances/,
        respond: { balances: [{ balance_amount: { amount: '1520.75', currency: 'EUR' }, balance_type: 'CLBD' }] },
      },
      {
        match: /\/accounts\/uid-a\/transactions\?date_from=2026-06-25$/,
        respond: {
          transactions: [
            { entry_reference: 't1', transaction_amount: { amount: '30', currency: 'EUR' }, credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-09-10' },
          ],
          continuation_key: 'page2',
        },
      },
      {
        match: /continuation_key=page2/,
        respond: {
          transactions: [
            { entry_reference: 't2', transaction_amount: { amount: '100', currency: 'EUR' }, credit_debit_indicator: 'CRDT', status: 'BOOK', booking_date: '2026-09-12' },
          ],
          continuation_key: null,
        },
      },
    ],
  });

  const accounts = await enableBankingConnector.syncAccounts(ctx);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.externalAccountId, 'eb:hash-stable');
  assert.equal(accounts[0]?.name, 'Crédit Agricole · Compte courant ••0123');
  assert.equal(accounts[0]?.type, 'CASH');
  assert.equal(JSON.stringify(accounts).includes('FR7612345678901234567890123'), false);

  const balances = await enableBankingConnector.syncBalances(ctx, accounts);
  assert.equal(balances[0]?.cash, 1520.75);

  const { items } = await enableBankingConnector.syncTransactions(ctx, {});
  assert.deepEqual(items.map((item) => [item.externalTransactionId, item.amount]), [['t1', -30], ['t2', 100]]);

  // Toutes les requêtes portent un jeton signé, jamais la clé elle-même.
  for (const request of http.requests) {
    assert.match(request.options.headers?.Authorization ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(JSON.stringify(request).includes('PRIVATE KEY'), false);
  }
});

test('session expirée ou application non configurée : consigne de renouvellement', async () => {
  const expired = makeTestContext({
    config: { aspsp_name: 'Revolut', aspsp_country: 'FR' },
    secrets: { enablebanking_application_id: APP, enablebanking_private_key: PEM, enablebanking_session_id: 's' },
    routes: [{ match: /\/sessions\/s$/, respond: jsonResponse({ status: 'EXPIRED', accounts: [] }) }],
  });
  const result = await enableBankingConnector.testConnection(expired.ctx);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'AUTH_REQUIRED');
  assert.match(result.message, /expirée/);

  const missing = await enableBankingConnector.testConnection(makeTestContext().ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /non configurée/);
});
