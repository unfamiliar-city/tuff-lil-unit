import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tuff } from '../../src/tuff.js';
import { makeTempDir, cleanup, ITEMS_SQL } from './helpers.js';

describe('J6 — ETL with upsert (idempotent)', () => {
  test('upsert 5 items, then re-run — still exactly 5 rows', async () => {
    const stateDir = makeTempDir();

    const runPipeline = () =>
      tuff('j6', { stateDir, concurrency: 3, setup: [ITEMS_SQL] }, async (ctx) => {
        const count = await ctx.upsert(
          [
            { id: 'i1', value: 'alpha', count: 1 },
            { id: 'i2', value: 'beta', count: 2 },
            { id: 'i3', value: 'gamma', count: 3 },
            { id: 'i4', value: 'delta', count: 4 },
            { id: 'i5', value: 'epsilon', count: 5 },
          ],
          {
            table: 'items',
            key: (item) => `item-${item.id}`,
            run: async (item) => item,
          },
        );
        return count;
      });

    try {
      const count1 = await runPipeline();
      assert.equal(count1, 5);

      const sqliteDb = new Database(`${stateDir}/tuff.db`);
      const rows1 = sqliteDb.prepare('SELECT * FROM items ORDER BY id').all() as { id: string; value: string; count: number }[];
      assert.equal(rows1.length, 5);
      assert.equal(rows1[0]?.id, 'i1');
      assert.equal(rows1[0]?.value, 'alpha');

      // Re-run: idempotent
      const count2 = await runPipeline();
      assert.equal(count2, 5, 'count should still be 5 on re-run');

      const rows2 = sqliteDb.prepare('SELECT * FROM items ORDER BY id').all();
      assert.equal(rows2.length, 5, 'still exactly 5 rows in db');
      sqliteDb.close();
    } finally {
      cleanup(stateDir);
    }
  });
});

describe('J9 — Cross-run data sharing', () => {
  test('pipeline B finds rows written by pipeline A in the same stateDir', async () => {
    const stateDir = makeTempDir();

    try {
      // Pipeline A: upsert 3 rows
      await tuff('j9-a', { stateDir, concurrency: 2, setup: [ITEMS_SQL] }, async (ctx) => {
        await ctx.upsert(
          [
            { id: 'shared1', value: 'from-a', count: 10 },
            { id: 'shared2', value: 'from-a', count: 20 },
            { id: 'shared3', value: 'from-a', count: 30 },
          ],
          {
            table: 'items',
            key: (item) => `j9a-${item.id}`,
            run: async (item) => item,
          },
        );
      });

      // Pipeline B: should see A's rows via ctx.db
      const result = await tuff('j9-b', { stateDir, concurrency: 1, setup: [ITEMS_SQL] }, async (ctx) => {
        const rows = ctx.db.prepare('SELECT * FROM items ORDER BY id').all();
        return rows;
      });

      assert.equal((result as unknown[]).length, 3, 'pipeline B should find 3 rows from pipeline A');

      // Both runs should appear in tuff_runs
      const sqliteDb = new Database(`${stateDir}/tuff.db`);
      const runA = sqliteDb.prepare('SELECT id FROM tuff_runs WHERE id=?').get('j9-a');
      const runB = sqliteDb.prepare('SELECT id FROM tuff_runs WHERE id=?').get('j9-b');
      assert.ok(runA, 'j9-a run should be in tuff_runs');
      assert.ok(runB, 'j9-b run should be in tuff_runs');
      sqliteDb.close();
    } finally {
      cleanup(stateDir);
    }
  });
});
