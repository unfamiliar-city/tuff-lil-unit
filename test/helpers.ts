import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { SCHEMA_SQL } from '../src/schema.js';
import { syncSchema } from '../src/schema-sync.js';

export function createTestDb(stateDir: string): Database.Database {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(`${stateDir}/tuff.db`);
  db.pragma('journal_mode = WAL');
  syncSchema(db, SCHEMA_SQL);
  return db;
}
