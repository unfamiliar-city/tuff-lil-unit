import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { autoStringify, upsertRow } from '../../src/upsert.js';
import { Context } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { syncSchema } from '../../src/schema-sync.js';
import { SCHEMA_SQL } from '../../src/schema.js';

const DOCS_SQL = `CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  body TEXT
)`;

const TAGS_SQL = `CREATE TABLE IF NOT EXISTS tags (
  doc_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  score INTEGER,
  PRIMARY KEY (doc_id, tag)
)`;

const NO_PK_SQL = `CREATE TABLE IF NOT EXISTS no_pk (col TEXT)`;

function createTestDb(stateDir: string, extraSql: string[] = []): Database.Database {
  const db = new Database(`${stateDir}/upsert.db`);
  syncSchema(db, [...extraSql]);
  return db;
}

function createFullTestDb(stateDir: string, extraSql: string[] = []): Database.Database {
  const db = new Database(`${stateDir}/tuff.db`);
  db.pragma('journal_mode = WAL');
  syncSchema(db, [...SCHEMA_SQL, ...extraSql]);
  return db;
}

describe('autoStringify', () => {
  test('stringifies plain objects', () => {
    const result = autoStringify({ a: { x: 1 }, b: 'plain' });
    assert.equal(result.a, '{"x":1}');
    assert.equal(result.b, 'plain');
  });

  test('stringifies arrays', () => {
    const result = autoStringify({ arr: [1, 2, 3], n: 42 });
    assert.equal(result.arr, '[1,2,3]');
    assert.equal(result.n, 42);
  });

  test('passes through primitives and null; coerces booleans', () => {
    const result = autoStringify({ n: 0, s: '', b: false, t: true, nil: null });
    assert.equal(result.n, 0);
    assert.equal(result.s, '');
    assert.equal(result.b, 0);
    assert.equal(result.t, 1);
    assert.equal(result.nil, null);
  });

  test('skips class instances (not plain objects)', () => {
    class Foo { x = 1; }
    const result = autoStringify({ obj: new Foo() });
    assert.ok(result.obj instanceof Foo);
  });
});

describe('upsertRow', () => {
  test('insert new row', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'upsert-test-'));
    const db = createTestDb(stateDir, [DOCS_SQL]);

    upsertRow(db, 'docs', { id: 'doc1', body: 'hello' });

    const rows = db.prepare('SELECT * FROM docs').all() as { id: string; body: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, 'doc1');
    assert.equal(rows[0]!.body, 'hello');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('conflict update — existing row gets overwritten', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'upsert-test-'));
    const db = createTestDb(stateDir, [DOCS_SQL]);

    upsertRow(db, 'docs', { id: 'doc1', body: 'v1' });
    upsertRow(db, 'docs', { id: 'doc1', body: 'v2' });

    const rows = db.prepare('SELECT * FROM docs').all() as { id: string; body: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.body, 'v2');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('updateColumns override — only specified columns updated on conflict', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'upsert-test-'));
    const db = createTestDb(stateDir, [DOCS_SQL]);

    upsertRow(db, 'docs', { id: 'doc1', body: 'original' });
    // Conflict but only update 'id' (PK field same as set target — body unchanged)
    upsertRow(db, 'docs', { id: 'doc1', body: 'new' }, ['id']);

    const rows = db.prepare('SELECT * FROM docs').all() as { id: string; body: string }[];
    assert.equal(rows[0]!.body, 'original', 'body should not change when not in updateColumns');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('composite PK upsert', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'upsert-test-'));
    const db = createTestDb(stateDir, [TAGS_SQL]);

    upsertRow(db, 'tags', { doc_id: 'd1', tag: 'news', score: 1 });
    upsertRow(db, 'tags', { doc_id: 'd1', tag: 'news', score: 99 });

    const rows = db.prepare('SELECT * FROM tags').all() as { doc_id: string; tag: string; score: number }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.score, 99);

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('no primary key throws', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'upsert-test-'));
    const db = createTestDb(stateDir, [NO_PK_SQL]);

    assert.throws(() => upsertRow(db, 'no_pk', { col: 'val' }), /No primary key found/);

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context.upsert', () => {
  test('happy path: 3 items → count=3, all rows in db', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-happy';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    const count = await ctx.upsert(
      ['a', 'b', 'c'],
      {
        table: 'docs',
        key: (id) => `doc-${id}`,
        run: async (id) => ({ id, body: `body-${id}` }),
      },
    );

    assert.equal(count, 3);
    const rows = db.prepare('SELECT id FROM docs ORDER BY id').all() as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('skip predicate — reduces count, skipped row absent from db', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-skip';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    const count = await ctx.upsert(
      ['keep', 'skip-me'],
      {
        table: 'docs',
        key: (id) => `skip-${id}`,
        run: async (id) => ({ id, body: id }),
        skip: (result) => (result as { id: string }).id === 'skip-me',
      },
    );

    assert.equal(count, 1, 'skip predicate should reduce count');
    const rows = db.prepare('SELECT id FROM docs').all() as { id: string }[];
    assert.ok(!rows.some((r) => r.id === 'skip-me'), 'skipped row should not be in db');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('map transformer — row value transformed before upsert', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-map';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    await ctx.upsert(
      ['x'],
      {
        table: 'docs',
        key: (id) => `map-${id}`,
        run: async (id) => ({ id, body: 'raw', extra: 'ignored' }),
        map: (result) => ({ id: (result as { id: string }).id, body: 'MAPPED' }),
      },
    );

    const row = db.prepare("SELECT body FROM docs WHERE id='x'").get() as { body: string } | undefined;
    assert.equal(row?.body, 'MAPPED');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('update override — only specified columns updated on conflict', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-update';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    // Seed the row manually
    db.prepare("INSERT INTO docs VALUES ('u1', 'original')").run();

    await ctx.upsert(
      ['u1'],
      {
        table: 'docs',
        key: (id) => `update-${id}`,
        run: async (id) => ({ id, body: 'new-value' }),
        update: ['id'],
      },
    );

    const row = db.prepare("SELECT body FROM docs WHERE id='u1'").get() as { body: string } | undefined;
    assert.equal(row?.body, 'original', 'body should not change when not in update list');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('memoization: second run same items — fn not re-called, count same', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-memo';
    let callCount = 0;

    const runUpsert = () => {
      const ctx = new Context({
        id: runId, concurrency: 5,
        signal: new AbortController().signal,
        state: new StateManager(db, runId),
        budgetManager: new BudgetManager(),
        db,
      });
      return ctx.upsert(
        ['m1', 'm2'],
        {
          table: 'docs',
          key: (id) => `memo-${id}`,
          run: async (id) => { callCount++; return { id, body: 'v' }; },
        },
      );
    };

    const count1 = await runUpsert();
    assert.equal(callCount, 2);
    assert.equal(count1, 2);

    callCount = 0;
    const count2 = await runUpsert();
    assert.equal(callCount, 0, 'fn should not re-execute on second run (memoized)');
    assert.equal(count2, 2, 'upsert count should still be 2 on re-run');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('empty array → returns 0', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-empty';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    const count = await ctx.upsert([], { table: 'docs', key: (id) => id, run: async (id) => ({ id, body: '' }) });
    assert.equal(count, 0);

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('array value in result — stored as JSON string in db (autoStringify)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-upsert-'));
    const db = createFullTestDb(stateDir, [DOCS_SQL]);

    const runId = 'upsert-arr';
    const ctx = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: new StateManager(db, runId),
      budgetManager: new BudgetManager(),
      db,
    });

    await ctx.upsert(
      ['arr1'],
      {
        table: 'docs',
        key: (id) => `arr-${id}`,
        run: async (id) => ({ id, body: ['tag1', 'tag2'] }),
        map: (result) => ({
          id: (result as { id: string }).id,
          body: (result as { body: string[] }).body,
        }),
      },
    );

    const row = db.prepare("SELECT body FROM docs WHERE id='arr1'").get() as { body: string } | undefined;
    assert.equal(row?.body, '["tag1","tag2"]', 'array should be stored as JSON string');

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});
