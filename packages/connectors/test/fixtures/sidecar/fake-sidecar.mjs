#!/usr/bin/env node
// Faux sidecar scripté, utilisé UNIQUEMENT par les tests hors ligne.
//
// Il respecte exactement le protocole décrit dans docs/connectors/sidecars.md :
// une requête JSON sur stdin ({ operation, params, secrets, timeoutMs }) et une
// réponse JSON sur stdout. Son comportement est piloté par variables
// d'environnement, ce qui permet de simuler succès, MFA, session expirée, 429,
// panne, réponse invalide, etc. AUCUN identifiant réel n'est utilisé.
//
//   SUIVIINVEST_FAKE_SIDECAR_PROVIDER = degiro | trade-republic   (défaut: degiro)
//   SUIVIINVEST_FAKE_SIDECAR_MODE =
//     success | mfa | mfa-then-success | session-expired | rate-limited |
//     down | garbage | no-ok | unknown-code | crash | hang | leak-stderr
//   SUIVIINVEST_FAKE_SIDECAR_STATE = chemin du marqueur pour « mfa-then-success »

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function failure(code, message, requiresUserAction) {
  return {
    ok: false,
    code,
    message,
    ...(requiresUserAction === undefined ? {} : { requiresUserAction }),
  };
}

const provider = process.env.SUIVIINVEST_FAKE_SIDECAR_PROVIDER ?? 'degiro';
const mode = process.env.SUIVIINVEST_FAKE_SIDECAR_MODE ?? 'success';

const DEGIRO = {
  accounts: {
    accounts: [
      { id: '12345678', name: 'Compte-titres DEGIRO', currency: 'EUR', type: 'SECURITIES', balance: 2500.5 },
      { id: '12345678-cash', name: 'Compte espèces EUR', currency: 'EUR', type: 'CASH', balance: 812.34 },
    ],
  },
  balances: {
    balances: [{ accountId: '12345678-cash', date: '2026-04-15', cash: 812.34, currency: 'EUR' }],
  },
  positions: {
    positions: [
      {
        accountId: '12345678',
        productId: 'P123',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 10,
        price: 100.5,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  transactions: {
    transactions: [
      {
        accountId: '12345678',
        id: 'AAAA1111-0000-4000-8000-000000000001',
        date: '2026-03-01',
        type: 'Achat',
        description: 'Achat 10 Exemple Monde UCITS ETF@100,50 EUR (FR0000000001)',
        product: 'Exemple Monde UCITS ETF',
        isin: 'FR0000000001',
        quantity: 10,
        price: 100.5,
        amount: -1005,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
      },
    ],
    cursor: null,
  },
  income: {
    income: [
      {
        accountId: '12345678-cash',
        id: 'DIV-1',
        date: '2026-03-10',
        type: 'Dividende',
        description: 'Dividende Exemple Monde',
        amount: 12.5,
        currency: 'EUR',
        withholdingTax: 2.5,
      },
    ],
  },
  test: { library: 'degiro-connector', readOnly: true },
};

const TRADE_REPUBLIC = {
  portfolio: {
    accounts: [
      { id: 'securities', name: 'Portefeuille Trade Republic', currency: 'EUR', type: 'SECURITIES', balance: 1200 },
    ],
    positions: [
      {
        accountId: 'securities',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 1.23456789,
        price: 97.42,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  cash: {
    balances: [{ accountId: 'cash', date: '2026-04-15', cash: 500.25, currency: 'EUR' }],
  },
  positions: {
    positions: [
      {
        accountId: 'securities',
        isin: 'FR0000000001',
        name: 'Exemple Monde UCITS ETF',
        quantity: 1.23456789,
        price: 97.42,
        currency: 'EUR',
        kind: 'ETF',
      },
    ],
  },
  transactions: {
    transactions: [
      {
        accountId: 'securities',
        id: 'tr-tx-1',
        date: '2026-04-01',
        category: 'TRADING',
        type: 'BUY',
        description: 'Achat Exemple Monde UCITS ETF',
        name: 'Exemple Monde UCITS ETF',
        isin: 'FR0000000001',
        quantity: 5,
        price: 100,
        amount: -500,
        currency: 'EUR',
        fees: 0.99,
        taxes: 0,
      },
      {
        accountId: 'cash',
        id: 'tr-tx-2',
        date: '2026-04-05',
        category: 'CASH',
        type: 'TRANSFER_INSTANT_INBOUND',
        description: 'Virement reçu',
        amount: 300,
        currency: 'EUR',
        fees: 0,
        taxes: 0,
      },
    ],
    cursor: null,
  },
  income: {
    income: [
      {
        accountId: 'cash',
        id: 'tr-div-1',
        date: '2026-04-09',
        type: 'DIVIDEND',
        description: 'Dividende Exemple Monde',
        amount: 4.56,
        currency: 'EUR',
        withholdingTax: 0.68,
      },
    ],
  },
  savingsplans: {
    savingsPlans: [
      { id: 'sp-1', isin: 'FR0000000001', name: 'Plan Exemple Monde', amount: 50, interval: 'MONTHLY', currency: 'EUR', active: true },
    ],
  },
  test: { library: 'pytr', readOnly: true },
};

function successData(operation) {
  const table = provider === 'trade-republic' ? TRADE_REPUBLIC : DEGIRO;
  return table[operation] ?? null;
}

function mfaMessage() {
  return provider === 'trade-republic'
    ? 'Validation Trade Republic requise'
    : "Validation requise dans l'application DEGIRO (ou captcha) : approuvez la connexion puis relancez.";
}

async function main() {
  const raw = await readStdin();
  let request = {};
  try {
    request = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    request = {};
  }
  const operation = typeof request.operation === 'string' ? request.operation : 'test';
  const secrets = request.secrets && typeof request.secrets === 'object' ? request.secrets : {};

  switch (mode) {
    case 'garbage':
      process.stdout.write('ceci-n-est-pas-du-json\n');
      return;
    case 'no-ok':
      send({ data: {} });
      return;
    case 'unknown-code':
      send({ ok: false, code: 'BANANA', message: 'code inconnu' });
      return;
    case 'crash':
      process.exit(2);
    case 'hang':
      // Le transport doit tuer le processus au dépassement de délai.
      setTimeout(() => process.exit(0), 30_000);
      return;
    case 'leak-stderr':
      // Écrit les secrets reçus sur stderr puis échoue : le transport doit les masquer.
      process.stderr.write(`échec critique ${JSON.stringify(secrets)}\n`);
      process.exit(1);
    case 'session-expired':
      send(failure('SESSION_EXPIRED', 'Session DEGIRO/Trade Republic expirée : reconnectez-vous.'));
      return;
    case 'rate-limited':
      send(failure('RATE_LIMITED', 'HTTP 429 : trop de requêtes, réessayez plus tard.'));
      return;
    case 'down':
      send(failure('PROVIDER_DOWN', 'Service du fournisseur injoignable (DNS/timeout).'));
      return;
    case 'mfa':
      send(failure('MFA_REQUIRED', mfaMessage(), true));
      return;
    case 'mfa-then-success': {
      const state = process.env.SUIVIINVEST_FAKE_SIDECAR_STATE;
      if (state && existsSync(state)) {
        break; // validation déjà effectuée : on reprend la synchronisation
      }
      if (state) {
        mkdirSync(dirname(state), { recursive: true });
        writeFileSync(state, 'approved\n');
      }
      send(failure('MFA_REQUIRED', mfaMessage(), true));
      return;
    }
    default:
      break;
  }

  if (operation === 'test') {
    send({ ok: true, data: successData('test'), warnings: [] });
    return;
  }
  const data = successData(operation);
  if (data === null) {
    send(failure('NOT_SUPPORTED', `Opération inconnue : ${operation}`));
    return;
  }
  send({ ok: true, data });
}

main();
