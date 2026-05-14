import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'cross-run-test-'));
}

const ITEMS_SQL = `CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  label TEXT,
  score INTEGER
)`;

describe('Integration: Cross-Run Domain Storage', () => {
  it('phase-1 writes domain rows, phase-2 reads them from same stateDir', async () => {
    const stateDir = tmpDir();
    const setup = [ITEMS_SQL];

    // Phase 1: crawl + store
    await tuff('phase-1', { stateDir, concurrency: 2, setup }, async (ctx) => {
      await ctx.step('crawl-a', async () => 'data-a');
      await ctx.step('crawl-b', async () => 'data-b');

      ctx.db.prepare('INSERT INTO items (id, label, score) VALUES (?, ?, ?)').run('a', 'Item A', 80);
      ctx.db.prepare('INSERT INTO items (id, label, score) VALUES (?, ?, ?)').run('b', 'Item B', 60);
    });

    // Phase 2: analyze rows written by phase 1
    const result = await tuff('phase-2', { stateDir, concurrency: 2, setup }, async (ctx) => {
      const rows = ctx.db.prepare('SELECT * FROM items').all() as { id: string; label: string; score: number }[];
      assert.equal(rows.length, 2);

      const itemA = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get('a') as { id: string; label: string; score: number } | undefined;
      assert.ok(itemA);
      assert.equal(itemA.label, 'Item A');
      assert.equal(itemA.score, 80);

      return rows.map((r) => r.id).sort();
    });

    assert.deepEqual(result, ['a', 'b']);

    rmSync(stateDir, { recursive: true });
  });

  it('both runs visible in same DB file', async () => {
    const stateDir = tmpDir();
    const setup = [ITEMS_SQL];

    await tuff('run-alpha', { stateDir, concurrency: 1, setup }, async (ctx) => {
      await ctx.step('s1', async () => 'alpha-result');
      ctx.db.prepare('INSERT INTO items (id, label, score) VALUES (?, ?, ?)').run('alpha', 'Alpha', 1);
    });

    await tuff('run-beta', { stateDir, concurrency: 1, setup }, async (ctx) => {
      await ctx.step('s1', async () => 'beta-result');
      ctx.db.prepare('INSERT INTO items (id, label, score) VALUES (?, ?, ?)').run('beta', 'Beta', 2);

      // Both domain rows visible
      const allItems = ctx.db.prepare('SELECT * FROM items').all();
      assert.equal(allItems.length, 2);
    });

    rmSync(stateDir, { recursive: true });
  });
});
