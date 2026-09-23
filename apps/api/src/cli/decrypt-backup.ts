#!/usr/bin/env node
/**
 * Déchiffrement d'une sauvegarde chiffrée (`.db.enc`, `.json.enc`, `.csv.enc`).
 *
 * Nécessite la MÊME clé maîtresse que celle du serveur qui a produit le fichier
 * (`SUIVIINVEST_MASTER_KEY`, lue depuis l'environnement — jamais en argument,
 * pour qu'elle n'apparaisse pas dans l'historique du shell).
 *
 * Usage :
 *   node apps/api/src/cli/decrypt-backup.ts <fichier.enc> [fichier-de-sortie]
 *
 * Sans fichier de sortie, le suffixe `.enc` est retiré.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decryptBackupBytes } from '../services/backup.ts';

function main(argv: readonly string[]): number {
  const [input, output] = argv;
  if (input === undefined || input === '--help' || input === '-h') {
    process.stdout.write('Usage : node apps/api/src/cli/decrypt-backup.ts <fichier.enc> [sortie]\n');
    return input === undefined ? 1 : 0;
  }
  const masterKey = process.env.SUIVIINVEST_MASTER_KEY ?? '';
  if (masterKey === '') {
    process.stderr.write('SUIVIINVEST_MASTER_KEY absente de l’environnement : impossible de déchiffrer.\n');
    return 1;
  }
  if (!existsSync(input)) {
    process.stderr.write(`Fichier introuvable : ${input}\n`);
    return 1;
  }
  const target = output ?? (input.endsWith('.enc') ? input.slice(0, -4) : `${input}.dechiffre`);
  if (existsSync(target)) {
    process.stderr.write(`Le fichier de sortie existe déjà : ${target}\n`);
    return 1;
  }
  writeFileSync(target, decryptBackupBytes(readFileSync(input), masterKey), { mode: 0o600 });
  process.stdout.write(`Sauvegarde déchiffrée : ${target}\n`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
