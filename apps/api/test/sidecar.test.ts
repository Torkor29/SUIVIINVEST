import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { degiroConnector, tradeRepublicConnector } from '@suiviinvest/connectors';
import { createSidecarTransport } from '../src/services/sidecar.ts';
import {
  createSidecarTransports,
  resolveSidecarEndpoint,
  sidecarEnvPrefix,
} from '../src/services/sidecar-registry.ts';

/**
 * Transport de sidecar, testé hors ligne contre un FAUX exécutable scripté
 * (`packages/connectors/test/fixtures/sidecar/fake-sidecar.mjs`).
 * Aucun identifiant réel, aucun appel à DEGIRO ou Trade Republic.
 */

const FAKE_SIDECAR = fileURLToPath(
  new URL('../../../packages/connectors/test/fixtures/sidecar/fake-sidecar.mjs', import.meta.url),
);

function execTransport(
  env: Readonly<Record<string, string>> = {},
  options: { command?: string; name?: string; timeoutMs?: number } = {},
) {
  return createSidecarTransport(options.name ?? 'degiro', {
    command: options.command ?? process.execPath,
    args: [FAKE_SIDECAR],
    env: { SUIVIINVEST_FAKE_SIDECAR_PROVIDER: 'degiro', ...env },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

test('sidecar exec : aller-retour JSON réussi sur stdin/stdout', async () => {
  const transport = execTransport();
  assert.equal(transport.isAvailable(), true);

  const response = await transport.call<{ accounts: unknown[] }>({
    operation: 'accounts',
    params: {},
    secrets: {},
  });
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(response.data.accounts.length, 2);
  }

  const positions = await transport.call<{ positions: unknown[] }>({ operation: 'positions' });
  assert.equal(positions.ok, true);
  if (positions.ok) assert.equal(positions.data.positions.length, 1);
});

test('sidecar : MFA_REQUIRED avec requiresUserAction et message exact (Trade Republic)', async () => {
  const transport = execTransport(
    { SUIVIINVEST_FAKE_SIDECAR_MODE: 'mfa', SUIVIINVEST_FAKE_SIDECAR_PROVIDER: 'trade-republic' },
    { name: 'trade-republic' },
  );
  const response = await transport.call({ operation: 'test' });
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.code, 'MFA_REQUIRED');
    assert.equal(response.requiresUserAction, true);
    assert.equal(response.message, 'Validation Trade Republic requise');
  }
});

test('sidecar : MFA puis REPRISE au prochain appel (marqueur d\'état)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sidecar-state-'));
  const state = join(directory, 'approved.marker');
  const transport = execTransport(
    { SUIVIINVEST_FAKE_SIDECAR_MODE: 'mfa-then-success', SUIVIINVEST_FAKE_SIDECAR_STATE: state },
    { name: 'trade-republic' },
  );

  const first = await transport.call({ operation: 'test' });
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.code, 'MFA_REQUIRED');

  // L'utilisateur a validé dans l'app entre-temps : la session est reprise.
  const second = await transport.call({ operation: 'test' });
  assert.equal(second.ok, true);
  rmSync(directory, { recursive: true, force: true });
});

test('sidecar : codes d\'erreur du fournisseur transmis tels quels', async () => {
  const cases: readonly { mode: string; code: string }[] = [
    { mode: 'session-expired', code: 'SESSION_EXPIRED' },
    { mode: 'rate-limited', code: 'RATE_LIMITED' },
    { mode: 'down', code: 'PROVIDER_DOWN' },
  ];
  for (const testCase of cases) {
    const transport = execTransport({ SUIVIINVEST_FAKE_SIDECAR_MODE: testCase.mode });
    const response = await transport.call({ operation: 'positions' });
    assert.equal(response.ok, false, `mode ${testCase.mode}`);
    if (!response.ok) assert.equal(response.code, testCase.code);
  }
});

test('sidecar : réponse invalide => PROVIDER_BROKEN, jamais de donnée devinée', async () => {
  for (const mode of ['garbage', 'no-ok', 'unknown-code']) {
    const transport = execTransport({ SUIVIINVEST_FAKE_SIDECAR_MODE: mode });
    const response = await transport.call({ operation: 'accounts' });
    assert.equal(response.ok, false, `mode ${mode}`);
    if (!response.ok) {
      assert.equal(response.code, 'PROVIDER_BROKEN', `mode ${mode}`);
      assert.ok(response.message.length > 0);
    }
  }
  // Un crash franc (sortie vide, code de sortie non nul) est aussi PROVIDER_BROKEN.
  const crash = execTransport({ SUIVIINVEST_FAKE_SIDECAR_MODE: 'crash' });
  const crashed = await crash.call({ operation: 'accounts' });
  assert.equal(crashed.ok, false);
  if (!crashed.ok) assert.equal(crashed.code, 'PROVIDER_BROKEN');
});

test('sidecar : binaire absent => isAvailable false et NOT_SUPPORTED actionnable', async () => {
  const transport = createSidecarTransport('degiro', {
    command: '/chemin/absolument/inexistant/sidecar-de-test',
  });
  assert.equal(transport.isAvailable(), false);
  const response = await transport.call({ operation: 'accounts' });
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.code, 'NOT_SUPPORTED');
    assert.match(response.message, /SUIVIINVEST_SIDECAR_DEGIRO/);
    assert.match(response.message, /sidecar\/README\.md/);
  }
});

test('sidecar : dépassement de délai => PROCESSUS TUÉ et PROVIDER_DOWN', async () => {
  const started = Date.now();
  const transport = execTransport({ SUIVIINVEST_FAKE_SIDECAR_MODE: 'hang' }, { timeoutMs: 400 });
  const response = await transport.call({ operation: 'test', timeoutMs: 400 });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.code, 'PROVIDER_DOWN');
  assert.ok(Date.now() - started < 5000, 'le transport a rendu la main rapidement');
});

test('sidecar : un secret présent dans stderr ne fuit jamais dans le message', async () => {
  const SECRET = 'super-secret-valeur-XYZ';
  const transport = execTransport({ SUIVIINVEST_FAKE_SIDECAR_MODE: 'leak-stderr' });
  const response = await transport.call({
    operation: 'test',
    secrets: { password: SECRET, username: 'utilisateur' },
  });
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.message.includes(SECRET), false, 'le secret a fuité dans le message');
    assert.match(response.message, /\*\*\*/);
  }
});

test('sidecar HTTP : POST JSON et lecture de la réponse', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { operation: string };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: { operation: parsed.operation } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const transport = createSidecarTransport('degiro', {
      type: 'http',
      url: `http://127.0.0.1:${port}`,
    });
    assert.equal(transport.isAvailable(), true);
    const response = await transport.call<{ operation: string }>({ operation: 'positions' });
    assert.equal(response.ok, true);
    if (response.ok) assert.equal(response.data.operation, 'positions');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('sidecar HTTP : une page non JSON => PROVIDER_BROKEN', async () => {
  const server = createServer((_request, response) => {
    response.end('<html>erreur proxy</html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const transport = createSidecarTransport('degiro', {
      type: 'http',
      url: `http://127.0.0.1:${port}`,
    });
    const response = await transport.call({ operation: 'test' });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.code, 'PROVIDER_BROKEN');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('registry : non configuré => transport inerte, démarrage non bloqué', async () => {
  const transports = createSidecarTransports({ env: {}, register: false });
  assert.equal(transports.degiro.isAvailable(), false);
  assert.equal(transports['trade-republic'].isAvailable(), false);
  const response = await transports.degiro.call({ operation: 'test' });
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.code, 'NOT_SUPPORTED');
});

test('registry : résolution via variables d\'environnement', () => {
  const env = {
    [`${sidecarEnvPrefix('trade-republic')}_URL`]: 'http://127.0.0.1:9310',
    SUIVIINVEST_SIDECAR_DEGIRO_COMMAND: '/usr/bin/python3',
    SUIVIINVEST_SIDECAR_DEGIRO_ARGS: '["sidecar/degiro/sidecar.py"]',
    SUIVIINVEST_SIDECAR_DEGIRO_TIMEOUT_MS: '9000',
  };
  const degiro = resolveSidecarEndpoint('degiro', undefined, env);
  assert.deepEqual(degiro, {
    command: '/usr/bin/python3',
    args: ['sidecar/degiro/sidecar.py'],
    timeoutMs: 9000,
  });
  const tradeRepublic = resolveSidecarEndpoint('trade-republic', undefined, env);
  assert.deepEqual(tradeRepublic, { type: 'http', url: 'http://127.0.0.1:9310' });
  assert.equal(resolveSidecarEndpoint('degiro', undefined, {}), null);
});

test('registry : register:true déclare le sidecar aux connecteurs (capabilities.api)', () => {
  const transports = createSidecarTransports({
    degiro: { command: process.execPath, args: [FAKE_SIDECAR] },
    'trade-republic': { command: process.execPath, args: [FAKE_SIDECAR] },
    register: true,
  });
  assert.equal(transports.degiro.isAvailable(), true);
  assert.equal(transports['trade-republic'].isAvailable(), true);
  assert.equal(degiroConnector.capabilities.api, true);
  assert.equal(tradeRepublicConnector.capabilities.api, true);
  // Nettoyage global pour ne pas influencer d'autres tests du même fichier.
  createSidecarTransports({ env: {}, register: true });
  assert.equal(degiroConnector.capabilities.api, false);
  assert.equal(tradeRepublicConnector.capabilities.api, false);
});
