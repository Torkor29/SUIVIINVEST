import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Db } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

/**
 * Migrations et garanties de la base.
 *
 * Ces tests protègent les fondations : un schéma cassé ou un index de
 * déduplication manquant rendrait tout le reste faux.
 */

test('toutes les migrations s\'appliquent et sont idempotentes', () => {
  const db = new Db(':memory:');
  const applied = db.migrate();
  assert.equal(applied.length, MIGRATIONS.length);
  assert.equal(db.migrate().length, 0, 'la seconde exécution ne doit rien appliquer');

  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => row.name);
  for (const expected of [
    'accounts',
    'activities',
    'instruments',
    'valuations',
    'quotes',
    'fx_rates',
    'net_worth_snapshots',
    'properties',
    'property_loans',
    'property_cash_flows',
    'connections',
    'secrets',
    'sync_runs',
    'imports',
    'settings',
    'sessions',
    'users',
  ]) {
    assert.ok(tables.includes(expected), `table manquante : ${expected}`);
  }
  assert.deepEqual(db.health().ok, true);
  db.close();
});

test('un identifiant externe identique ne peut pas être inséré deux fois', () => {
  const db = new Db(':memory:');
  db.migrate();
  const insert = (id: string, external: string): void => {
    db.run(
      `INSERT INTO accounts (id,name,type,provider_id,currency,created_at,updated_at)
       VALUES (?,?,'CASH','degiro','EUR','2024-01-01','2024-01-01')`,
      id,
      `Compte ${id}`,
    );
    db.run(
      `INSERT INTO activities (id,account_id,type,date,amount,currency,provider_id,external_account_id,
         external_transaction_id,last_synced_at,dedup_hash,created_at,updated_at)
       VALUES (?,?,'BUY','2024-01-10',-100,'EUR','degiro','EXT',?,'2024-01-10T00:00:00Z','hash',?,?)`,
      `act-${id}`,
      id,
      external,
      '2024-01-10',
      '2024-01-10',
    );
  };
  insert('a1', 'TX-1');
  assert.throws(() => insert('a2', 'TX-1'), /UNIQUE constraint failed/);
  db.close();
});

test('deux lignes sans identifiant externe ne peuvent pas partager la même empreinte', () => {
  const db = new Db(':memory:');
  db.migrate();
  db.run(
    `INSERT INTO accounts (id,name,type,provider_id,currency,created_at,updated_at)
     VALUES ('a1','Compte','CASH','revolut','EUR','2024-01-01','2024-01-01')`,
  );
  const insert = (id: string, hash: string): void => {
    db.run(
      `INSERT INTO activities (id,account_id,type,date,amount,currency,provider_id,last_synced_at,
         dedup_hash,created_at,updated_at)
       VALUES (?,?,'BANK_EXPENSE','2024-03-01',-12.5,'EUR','revolut','2024-03-01T00:00:00Z',?,?,?)`,
      id,
      'a1',
      hash,
      '2024-03-01',
      '2024-03-01',
    );
  };
  insert('act1', 'empreinte-1');
  assert.throws(() => insert('act2', 'empreinte-1'), /UNIQUE constraint failed/);
  // Une empreinte différente reste acceptée : deux dépenses distinctes le même jour.
  insert('act3', 'empreinte-2');
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) c FROM activities')?.c, 2);
  db.close();
});

test('les clés étrangères sont actives (pas d\'activité orpheline)', () => {
  const db = new Db(':memory:');
  db.migrate();
  assert.throws(
    () =>
      db.run(
        `INSERT INTO activities (id,account_id,type,date,amount,currency,provider_id,last_synced_at,
           dedup_hash,created_at,updated_at)
         VALUES ('x','inexistant','BUY','2024-01-01',-1,'EUR','manual','2024-01-01T00:00:00Z','h','2024-01-01','2024-01-01')`,
      ),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test('la transaction annule toutes les écritures en cas d\'erreur', () => {
  const db = new Db(':memory:');
  db.migrate();
  assert.throws(() => {
    db.transaction(() => {
      db.run(
        `INSERT INTO accounts (id,name,type,provider_id,currency,created_at,updated_at)
         VALUES ('a1','Compte','CASH','manual','EUR','2024-01-01','2024-01-01')`,
      );
      throw new Error('échec volontaire');
    });
  }, /échec volontaire/);
  assert.equal(db.get<{ c: number }>('SELECT COUNT(*) c FROM accounts')?.c, 0);
  db.close();
});

test('la sauvegarde SQLite produit un fichier lisible', () => {
  const db = new Db(':memory:');
  db.migrate();
  db.run(
    `INSERT INTO accounts (id,name,type,provider_id,currency,created_at,updated_at)
     VALUES ('a1','Compte','CASH','manual','EUR','2024-01-01','2024-01-01')`,
  );
  const target = `${mkdtemp()}/backup.db`;
  db.backupTo(target);
  const restored = new Db(target);
  assert.equal(restored.get<{ c: number }>('SELECT COUNT(*) c FROM accounts')?.c, 1);
  assert.equal(restored.health().ok, true);
  restored.close();
  db.close();
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), 'suiviinvest-backup-'));
}