#!/usr/bin/env node
/**
 * Réinitialisation d'un mot de passe depuis le serveur.
 *
 * Dernier recours quand le mot de passe ET le code de récupération sont perdus :
 * il faut alors un accès au serveur (shell, SSH ou `docker compose exec`), c'est
 * le prix à payer pour une application sans e-mail ni service tiers.
 *
 * Usage :
 *   node apps/api/src/cli/reset-password.ts --list
 *   node apps/api/src/cli/reset-password.ts --username proprietaire            (saisie masquée)
 *   node apps/api/src/cli/reset-password.ts --username proprietaire --generate (mot de passe fort)
 *
 * Le mot de passe saisi n'apparaît jamais à l'écran, n'est jamais journalisé et
 * n'est jamais écrit en clair : seule son empreinte Argon2id rejoint la base.
 * Un nouveau code de récupération est émis et affiché une seule fois.
 */
import { randomInt } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { Db } from '../db/database.ts';
import { AuthService } from '../security/sessions.ts';
import { MIN_PASSWORD_LENGTH } from '../security/password.ts';

const ALPHABET_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const ALPHABET_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALPHABET_DIGITS = '23456789';
const ALPHABET_SYMBOLS = '!@#$%&*+-?';

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

/** Mot de passe fort aléatoire : 24 caractères, toutes catégories. */
function generatePassword(): string {
  const pools = [ALPHABET_LOWER, ALPHABET_UPPER, ALPHABET_DIGITS, ALPHABET_SYMBOLS];
  const all = pools.join('');
  const chars: string[] = pools.map((pool) => pool[randomInt(pool.length)] as string);
  while (chars.length < 24) chars.push(all[randomInt(all.length)] as string);
  // Mélange de Fisher-Yates : aucune position prévisible.
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap] as string, chars[index] as string];
  }
  return chars.join('');
}

/** Saisie masquée sur un terminal ; refuse tout autre contexte. */
async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      'Aucun terminal interactif : utilisez --generate ou --password (voir --help).',
    );
  }
  process.stdout.write(label);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          reject(new Error('Interrompu.'));
          return;
        }
        if (char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.has('help') || args.has('h')) {
    process.stdout.write(
      'Usage :\n' +
        '  --list                              liste les comptes\n' +
        '  --username <identifiant>            réinitialise ce compte\n' +
        '  --generate                          génère un mot de passe fort\n' +
        '  --password <mot de passe>           mot de passe imposé (déconseillé)\n',
    );
    return 0;
  }

  const config = loadConfig(process.env);
  const db = new Db(config.databasePath);
  db.migrate();
  const auth = new AuthService(db, {
    ttlMinutes: config.sessionTtlMinutes,
    cookieSecure: config.cookieSecure,
  });

  if (args.has('list')) {
    const accounts = auth.listAccounts();
    if (accounts.length === 0) {
      process.stdout.write('Aucun compte : ouvrez l’application pour créer le premier.\n');
      return 0;
    }
    for (const account of accounts) {
      process.stdout.write(
        `- ${account.username ?? '(sans identifiant)'} [${account.role}]` +
          `${account.disabled ? ' (désactivé)' : ''}` +
          ` — connexion : ${account.lastLoginAt ?? 'jamais'}\n`,
      );
    }
    return 0;
  }

  const requested = args.get('username');
  if (typeof requested !== 'string') {
    process.stderr.write('Identifiant requis : --username <identifiant> (voir --list).\n');
    return 1;
  }
  const username = requested.trim().toLowerCase();
  const account = auth
    .listAccounts()
    .find((row) => (row.username ?? '(sans identifiant)') === username || row.id === username);
  if (!account) {
    process.stderr.write(`Compte introuvable : ${username}\n`);
    return 1;
  }

  let password: string;
  const provided = args.get('password');
  if (typeof provided === 'string') {
    password = provided;
    process.stderr.write(
      '⚠️  Mot de passe fourni en ligne de commande : il figure dans l’historique du shell.\n',
    );
  } else if (args.has('generate')) {
    password = generatePassword();
  } else {
    password = await promptHidden(`Nouveau mot de passe pour ${username} : `);
    const again = await promptHidden('Confirmation : ');
    if (password !== again) {
      process.stderr.write('Les deux saisies diffèrent : rien n’a été modifié.\n');
      return 1;
    }
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    process.stderr.write(`Mot de passe trop court : ${MIN_PASSWORD_LENGTH} caractères minimum.\n`);
    return 1;
  }

  const { recoveryCode } = await auth.resetPasswordForced(account.id, password);
  process.stdout.write(
    '\nMot de passe remplacé. Toutes les sessions de ce compte ont été déconnectées.\n' +
      'Aucune trace en clair n’a été écrite : seule une empreinte Argon2id est en base.\n\n' +
      (typeof provided === 'string' || args.has('generate')
        ? `Mot de passe : ${password}\n`
        : '') +
      `Nouveau code de récupération (à conserver, affiché une seule fois) : ${recoveryCode}\n`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });