import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tuff } from '../../src/tuff.js';
import { makeTempDir, cleanup } from './helpers.js';

describe('J1 — Hello World', () => {
  test('single step returns value and persists to db', async () => {
    const stateDir = makeTempDir();
    try {
      const result = await tuff('j1', { stateDir, concurrency: 1 }, async (ctx) =>
        ctx.step('greet', async () => 'hello'),
      );

      assert.equal(result, 'hello');

      // Verify rows exist in tuff_runs and tuff_steps
      const sqliteDb = new Database(`${stateDir}/tuff.db`);
      const run = sqliteDb.prepare('SELECT id FROM tuff_runs WHERE id=?').get('j1') as { id: string } | undefined;
      assert.ok(run, 'tuff_runs row should exist');

      const step = sqliteDb
        .prepare('SELECT step_id FROM tuff_steps WHERE run_id=? AND step_id=?')
        .get('j1', 'greet') as { step_id: string } | undefined;
      assert.ok(step, 'tuff_steps row should exist for greet step');
      sqliteDb.close();
    } finally {
      cleanup(stateDir);
    }
  });
});

describe('J2 — Multi-step data flow', () => {
  test('complex object survives JSON round-trip — edge values preserved', async () => {
    const stateDir = makeTempDir();
    try {
      const edgeValues = { items: ['a', 'b'], nested: { count: 2 }, nullVal: null, zero: 0, empty: '' };

      const result = await tuff('j2', { stateDir, concurrency: 2 }, async (ctx) => {
        const stepA = await ctx.step('step-a', async () => edgeValues);
        const stepB = await ctx.step('step-b', async () => ({
          fromA: stepA,
          doubled: (stepA as typeof edgeValues).nested.count * 2,
        }));
        return stepB;
      });

      const r = result as { fromA: typeof edgeValues; doubled: number };
      assert.equal(r.doubled, 4);
      assert.equal(r.fromA.nullVal, null, 'null should survive JSON round-trip');
      assert.equal(r.fromA.zero, 0, 'zero should survive');
      assert.equal(r.fromA.empty, '', 'empty string should survive');
      assert.notEqual(r.fromA.nullVal, undefined, 'null should not become undefined');
    } finally {
      cleanup(stateDir);
    }
  });
});

describe('J3 — Fan-out/fan-in', () => {
  test('20-step fan-out respects concurrency=4, fan-in collects all results', async () => {
    const stateDir = makeTempDir();
    const progressEvents: { stage: string }[] = [];

    try {
      const result = await tuff(
        'j3',
        { stateDir, concurrency: 4, onProgress: (p) => progressEvents.push({ stage: p.stage }) },
        async (ctx) => {
          ctx.stage('process', { concurrency: 4 });

          let concurrentCount = 0;
          let maxConcurrent = 0;

          const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
              ctx.step(`item-${i}`, async () => {
                concurrentCount++;
                maxConcurrent = Math.max(maxConcurrent, concurrentCount);
                await new Promise((resolve) => setTimeout(resolve, 10));
                concurrentCount--;
                return i * 2;
              }),
            ),
          );

          assert.ok(maxConcurrent <= 4, `process concurrency exceeded: ${maxConcurrent}`);

          ctx.stage('aggregate');
          const sum = await ctx.step('sum', async () => results.reduce((a, b) => a + b, 0));
          return { sum, maxConcurrent };
        },
      );

      assert.equal(result.sum, 20 * 19); // sum of 0..38 step=2 = 0+2+4...+38 = 2*(0+1+...+19) = 2*190 = 380
      assert.ok(result.maxConcurrent <= 4);

      const stages = progressEvents.map((e) => e.stage);
      assert.ok(stages.includes('process'), 'should have process stage progress events');
      assert.ok(stages.includes('aggregate'), 'should have aggregate stage progress events');
    } finally {
      cleanup(stateDir);
    }
  });
});
