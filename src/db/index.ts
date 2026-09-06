import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { migrate } from './migrations.js';

const log = createLogger('db');

let instance: Database.Database | null = null;

/**
 * Ouvre (ou reutilise) la connexion SQLite.
 *
 * WAL + synchronous NORMAL : le bon compromis pour un process unique qui
 * ecrit par rafales pendant un cycle de collecte et lit en continu pour le
 * dashboard. `foreign_keys` doit etre active explicitement a chaque connexion.
 */
export function getDb(path = config.databasePath): Database.Database {
  if (instance) return instance;

  const absolute = resolve(path);
  if (absolute !== ':memory:') mkdirSync(dirname(absolute), { recursive: true });

  const db = new Database(absolute);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  instance = db;
  log.info('base ouverte', { path: absolute });
  return db;
}

/** Base en memoire, utilisee par les tests. Ne touche pas au singleton. */
export function createMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
