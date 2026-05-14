import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { syncSchema } from '../../src/schema-sync.js';
import { SCHEMA_SQL } from '../../src/schema.js';

function createDb(dir: string) {
  return new Database(`${dir}/tuff.db`);
}

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'schema-sync-test-'));
}

describe('syncSchema', () => {
  test('creates tables from SQL statements', () => {
    const dir = tmpDir();
    const db = createDb(dir);

    syncSchema(db, SCHEMA_SQL);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    assert.ok(names.includes('tuff_runs'));
    assert.ok(names.includes('tuff_steps'));
    assert.ok(names.includes('tuff_step_failures'));

    db.close();
    rmSync(dir, { recursive: true });
  });

  test('idempotent on second call', () => {
    const dir = tmpDir();
    const db = createDb(dir);

    syncSchema(db, SCHEMA_SQL);
    syncSchema(db, SCHEMA_SQL);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    assert.ok(names.includes('tuff_runs'));
    assert.ok(names.includes('tuff_steps'));

    db.close();
    rmSync(dir, { recursive: true });
  });

  test('empty schema — resolves without throwing, no tables created', () => {
    const dir = tmpDir();
    const db = createDb(dir);

    syncSchema(db, []);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    assert.equal(tables.length, 0, 'no tables should be created from empty schema');

    db.close();
    rmSync(dir, { recursive: true });
  });

  test('handles tuff + consumer schemas together', () => {
    const dir = tmpDir();
    const db = createDb(dir);

    const consumerSql = `CREATE TABLE IF NOT EXISTS pages (
      url TEXT PRIMARY KEY,
      title TEXT,
      word_count INTEGER
    )`;

    syncSchema(db, [...SCHEMA_SQL, consumerSql]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    assert.ok(names.includes('tuff_runs'));
    assert.ok(names.includes('tuff_steps'));
    assert.ok(names.includes('tuff_step_failures'));
    assert.ok(names.includes('pages'));

    db.close();
    rmSync(dir, { recursive: true });
  });

  test('adds new columns to existing tables', () => {
    const dir = tmpDir();
    const db = createDb(dir);

    const v1 = `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT
    )`;
    syncSchema(db, [v1]);

    const v2 = `CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT
    )`;
    syncSchema(db, [v2]);

    const columns = db
      .prepare("PRAGMA table_info('items')")
      .all() as { name: string }[];
    const colNames = columns.map((c) => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('name'));
    assert.ok(colNames.includes('description'));

    db.close();
    rmSync(dir, { recursive: true });
  });
});
