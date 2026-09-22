import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Chemin des navigateurs.
 *
 * Le cache standard `~/.cache/ms-playwright` est utilisé s'il existe. Là où il
 * est absent ou non inscriptible (image en lecture seule), le cache persistant
 * de la machine prend le relais s'il a été peuplé avec :
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/data/.cache/ms-playwright npx playwright install chromium
 */
if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined) {
  const standard = join(homedir(), '.cache', 'ms-playwright');
  const portable = '/opt/data/.cache/ms-playwright';
  if (!existsSync(standard) && existsSync(portable)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = portable;
  }
}

/**
 * Configuration Playwright des tests de bout en bout.
 *
 * Le harnais (`e2e/scripts/serve.mjs`) démarre l'API, sert le front construit et
 * utilise une base SQLite temporaire avec les connecteurs FACTICES
 * (`SUIVIINVEST_E2E_CONNECTORS=1`) : aucun réseau, aucun identifiant réel.
 *
 * Le port est demandé au système (port libre), donc deux exécutions simultanées
 * ne se marchent pas dessus. Il est résolu de façon SYNCHRONE : Playwright exige
 * un unique objet de configuration exporté (une fonction est refusée).
 *
 * Ordre d'exécution : le projet « setup » crée le mot de passe via l'interface
 * (premier lancement sur une base neuve) et enregistre l'état de session ; les
 * autres projets réutilisent cet état.
 */

/** Port libre demandé au système (résolution synchrone, via un processus node). */
function freePort(): number {
  const script =
    "const net=require('node:net');const s=net.createServer();" +
    "s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});";
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const port = Number.parseInt((result.stdout ?? '').trim(), 10);
  return Number.isInteger(port) && port > 0 ? port : 41827;
}

const port = Number(process.env.SUIVIINVEST_E2E_PORT ?? freePort());
const baseURL = `http://127.0.0.1:${port}`;
// Le port est figé dans l'environnement : si la configuration est réévaluée
// (worker, relance), elle réutilise LE MÊME port au lieu d'en tirer un nouveau
// et de pointer vers un serveur inexistant.
process.env.SUIVIINVEST_E2E_PORT = `${port}`;
const STORAGE_STATE = 'e2e/.auth/state.json';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/scripts/**'],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'e2e/.artifacts',
  use: {
    baseURL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    actionTimeout: 15_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: 'node e2e/scripts/serve.mjs',
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      SUIVIINVEST_E2E_PORT: `${port}`,
    },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.spec\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: /auth\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        browserName: 'chromium',
        storageState: STORAGE_STATE,
      },
    },
  ],
});