/**
 * Harnais de test de bout en bout.
 *
 * Démarre l'API SuiviInvest sur un port libre, avec :
 *  - une base SQLite temporaire (créée puis détruite : aucune donnée locale touchée) ;
 *  - les connecteurs FACTICES (`SUIVIINVEST_E2E_CONNECTORS=1`) : aucun appel réseau,
 *    aucun identifiant, des résultats déterministes ;
 *  - le front construit servi par l'API elle-même (`SUIVIINVEST_WEB_DIR`), ce qui
 *    supprime tout besoin d'un second serveur et donc toute collision de ports ;
 *  - l'ordonnanceur désactivé (pas de synchronisation surprise en arrière-plan).
 *
 * Le front est reconstruit seulement si `apps/web/dist/index.html` est absent :
 * Playwright ne doit pas payer une compilation à chaque exécution.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const port = Number(process.env.SUIVIINVEST_E2E_PORT ?? 41827);
const webDist = join(root, 'apps/web/dist');
const dataDir = mkdtempSync(join(tmpdir(), 'suiviinvest-e2e-'));
const dbPath = join(dataDir, 'e2e.db');

/**
 * Le front doit être reconstruit si le paquet est ABSENT **ou PÉRIMÉ**.
 *
 * Se contenter de « dist/index.html existe » fait tourner Playwright contre une
 * version antérieure du code dès qu'on modifie un composant : les tests passent
 * ou échouent sur un front qui n'est plus celui du dépôt. On compare donc la date
 * du bundle à celle des sources (front + paquets partagés).
 */
function sourceIsNewerThanBundle() {
  const bundle = join(webDist, 'index.html');
  if (!existsSync(bundle)) return true;
  const bundleTime = statSync(bundle).mtimeMs;
  const roots = [join(root, 'apps/web/src'), join(root, 'packages')];
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        stack.push(path);
        continue;
      }
      if (!/\.(ts|tsx|css|html|json)$/.test(entry.name)) continue;
      if (statSync(path).mtimeMs > bundleTime) return true;
    }
  }
  return false;
}

if (sourceIsNewerThanBundle()) {
  process.stderr.write('[e2e] front absent ou périmé : construction de apps/web/dist…\n');
  const build = spawnSync('npm', ['--workspace', '@suiviinvest/web', 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  if (build.status !== 0) {
    process.stderr.write('[e2e] la construction du front a échoué : arrêt.\n');
    process.exit(1);
  }
}

const child = spawn(process.execPath, ['apps/api/src/server.ts'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'development',
    SUIVIINVEST_HOST: '127.0.0.1',
    SUIVIINVEST_PORT: `${port}`,
    SUIVIINVEST_DB: dbPath,
    SUIVIINVEST_BACKUP_DIR: join(dataDir, 'backups'),
    SUIVIINVEST_WEB_DIR: webDist,
    // Clé maître jetable : les secrets de test ne survivent pas au processus.
    SUIVIINVEST_MASTER_KEY: 'e2e-master-key-not-a-secret-0123456789abcdef',
    SUIVIINVEST_E2E_CONNECTORS: '1',
    SUIVIINVEST_SCHEDULER_ENABLED: '0',
    SUIVIINVEST_LOG_LEVEL: 'warn',
    SUIVIINVEST_COOKIE_SECURE: '0',
    SUIVIINVEST_TRUST_PROXY: '0',
    // Les modules ES sont chargés en mode CORS : le navigateur envoie un en-tête
    // `Origin` même en same-origin, et le serveur refuse toute origine inconnue.
    // L'origine de test doit donc être explicitement autorisée.
    SUIVIINVEST_CORS_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  },
});

function cleanup(signal) {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* le dossier temporaire peut déjà être supprimé */
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup(signal);
    process.exit(0);
  });
}

child.on('exit', (code, signal) => {
  process.stderr.write(`[e2e] l'API s'est arrêtée (code=${code ?? 'null'}, signal=${signal ?? 'null'})\n`);
  cleanup('SIGTERM');
  process.exit(code ?? 1);
});
