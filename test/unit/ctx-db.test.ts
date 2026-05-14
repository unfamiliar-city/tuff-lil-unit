import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'ctx-db-test-'));
}

const PAGES_SQL = `CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  title TEXT,
  word_count INTEGER
)`;

describe('ctx.db', () => {
  test('insert + select with consumer schema tables', async () => {
    const stateDir = tmpDir();

    await tuff(
      'db-insert-select',
      { stateDir, concurrency: 1, setup: [PAGES_SQL] },
      async (ctx) => {
        ctx.db.prepare('INSERT INTO pages (url, title, word_count) VALUES (?, ?, ?)').run(
          'https://example.com', 'Example', 42,
        );

        const rows = ctx.db.prepare('SELECT * FROM pages WHERE url = ?').all('https://example.com') as { url: string; title: string; word_count: number }[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.title, 'Example');
        assert.equal(rows[0]!.word_count, 42);
      },
    );

    rmSync(stateDir, { recursive: true });
  });

  test('ctx.db available without config.setup (tuff tables only)', async () => {
    const stateDir = tmpDir();

    await tuff(
      'db-no-schema',
      { stateDir, concurrency: 1 },
      async (ctx) => {
        // db should be available — tuff internal tables exist
        assert.ok(ctx.db);

        await ctx.step('s1', async () => 'hello');
        // Verify step was persisted by reading it back via another step lookup
        const cached = await ctx.step('s1', async () => 'should-not-run');
        assert.equal(cached, 'hello');
      },
    );

    rmSync(stateDir, { recursive: true });
  });

  test('multiple tuff() calls share one DB', async () => {
    const stateDir = tmpDir();

    // Phase 1: write domain data
    await tuff(
      'phase-1',
      { stateDir, concurrency: 1, setup: [PAGES_SQL] },
      async (ctx) => {
        ctx.db.prepare('INSERT INTO pages (url, title, word_count) VALUES (?, ?, ?)').run('https://a.com', 'A', 10);
        ctx.db.prepare('INSERT INTO pages (url, title, word_count) VALUES (?, ?, ?)').run('https://b.com', 'B', 20);
      },
    );

    // Phase 2: read domain data written by phase 1
    await tuff(
      'phase-2',
      { stateDir, concurrency: 1, setup: [PAGES_SQL] },
      async (ctx) => {
        const rows = ctx.db.prepare('SELECT * FROM pages').all() as { url: string; title: string; word_count: number }[];
        assert.equal(rows.length, 2);

        const titles = rows.map((r) => r.title).sort();
        assert.deepEqual(titles, ['A', 'B']);
      },
    );

    rmSync(stateDir, { recursive: true });
  });
});
