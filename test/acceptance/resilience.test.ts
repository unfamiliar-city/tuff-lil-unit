import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tuff } from '../../src/tuff.js';
import { makeTempDir, cleanup } from './helpers.js';

describe('J4 — Crash and resume', () => {
  test('failed run resumes from crash point; prior steps cached, failure record cleared', async () => {
    const stateDir = makeTempDir();
    const callCounts = new Array(10).fill(0);

    const runPipeline = (shouldFailAt5: boolean) =>
      tuff('j4', { stateDir, concurrency: 5 }, async (ctx) => {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            ctx.step(`step-${i}`, async () => {
              callCounts[i]!++;
              if (shouldFailAt5 && i === 4) throw new Error('crash at step 5');
              return `result-${i}`;
            }),
          ),
        );
        return results;
      });

    try {
      // Run 1: crash at step 5
      await assert.rejects(() => runPipeline(true));

      const sqliteDb = new Database(`${stateDir}/tuff.db`);
      // Steps 0-3 should be in tuff_steps (completed before crash)
      for (let i = 0; i < 4; i++) {
        const row = sqliteDb
          .prepare('SELECT step_id FROM tuff_steps WHERE run_id=? AND step_id=?')
          .get('j4', `step-${i}`);
        assert.ok(row, `step-${i} should be persisted after run 1`);
      }
      // Step 4 should be in tuff_step_failures
      const failure = sqliteDb
        .prepare('SELECT step_id FROM tuff_step_failures WHERE run_id=? AND step_id=?')
        .get('j4', 'step-4') as { step_id: string } | undefined;
      assert.ok(failure, 'step-4 failure should be recorded');
      sqliteDb.close();

      // Reset call counts for run 2
      callCounts.fill(0);

      // Run 2: step 5 succeeds this time
      const results = await runPipeline(false);
      assert.equal((results as string[]).length, 10);

      // Steps 0-3 were cached — should not have re-executed
      for (let i = 0; i < 4; i++) {
        assert.equal(callCounts[i], 0, `step-${i} should be cached on resume`);
      }
      // Step 4 was failed — should re-execute once
      assert.equal(callCounts[4], 1, 'step-4 should re-execute after prior failure');

      // Verify failure record is cleared after success
      const sqliteDb2 = new Database(`${stateDir}/tuff.db`);
      const cleared = sqliteDb2
        .prepare('SELECT step_id FROM tuff_step_failures WHERE run_id=? AND step_id=?')
        .get('j4', 'step-4');
      assert.equal(cleared, undefined, 'failure record should be gone after successful retry');
      sqliteDb2.close();
    } finally {
      cleanup(stateDir);
    }
  });
});

describe('J7 — Force invalidation', () => {
  test('step force:true re-executes only that step; others remain cached', async () => {
    const stateDir = makeTempDir();
    const callCounts: Record<string, number> = {};

    const makeStep = (ctx: import('../../src/context.js').Context, id: string, options?: { force?: boolean }) =>
      ctx.step(id, async () => { callCounts[id] = (callCounts[id] ?? 0) + 1; return id; }, options);

    const runPipeline = (forceStep2 = false) =>
      tuff('j7-step', { stateDir, concurrency: 3 }, async (ctx) => {
        await makeStep(ctx, 's1');
        await makeStep(ctx, 's2', forceStep2 ? { force: true } : undefined);
        await makeStep(ctx, 's3');
      });

    try {
      // Run 1: all steps execute
      await runPipeline(false);
      assert.equal(callCounts['s1'], 1);
      assert.equal(callCounts['s2'], 1);
      assert.equal(callCounts['s3'], 1);

      // Run 2: step s2 forced
      await runPipeline(true);
      assert.equal(callCounts['s1'], 1, 's1 should remain cached');
      assert.equal(callCounts['s2'], 2, 's2 should re-execute with force:true');
      assert.equal(callCounts['s3'], 1, 's3 should remain cached');
    } finally {
      cleanup(stateDir);
    }
  });

  test('stage force:true re-executes all steps in that stage; other stages remain cached', async () => {
    const stateDir = makeTempDir();
    const callCounts: Record<string, number> = {};

    const runPipeline = (forceAlpha = false) =>
      tuff('j7-stage', { stateDir, concurrency: 5 }, async (ctx) => {
        ctx.stage('alpha', forceAlpha ? { force: true } : undefined);
        await Promise.all([
          ctx.step('a1', async () => { callCounts['a1'] = (callCounts['a1'] ?? 0) + 1; return 'a1'; }),
          ctx.step('a2', async () => { callCounts['a2'] = (callCounts['a2'] ?? 0) + 1; return 'a2'; }),
          ctx.step('a3', async () => { callCounts['a3'] = (callCounts['a3'] ?? 0) + 1; return 'a3'; }),
        ]);

        ctx.stage('beta');
        await Promise.all([
          ctx.step('b1', async () => { callCounts['b1'] = (callCounts['b1'] ?? 0) + 1; return 'b1'; }),
          ctx.step('b2', async () => { callCounts['b2'] = (callCounts['b2'] ?? 0) + 1; return 'b2'; }),
          ctx.step('b3', async () => { callCounts['b3'] = (callCounts['b3'] ?? 0) + 1; return 'b3'; }),
        ]);
      });

    try {
      // Run 1: all 6 steps execute
      await runPipeline(false);
      for (const key of ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']) {
        assert.equal(callCounts[key], 1, `${key} should execute once on run 1`);
      }

      // Run 2: force alpha stage
      await runPipeline(true);
      assert.equal(callCounts['a1'], 2, 'a1 should re-execute (alpha forced)');
      assert.equal(callCounts['a2'], 2, 'a2 should re-execute (alpha forced)');
      assert.equal(callCounts['a3'], 2, 'a3 should re-execute (alpha forced)');
      assert.equal(callCounts['b1'], 1, 'b1 should remain cached (beta not forced)');
      assert.equal(callCounts['b2'], 1, 'b2 should remain cached');
      assert.equal(callCounts['b3'], 1, 'b3 should remain cached');
    } finally {
      cleanup(stateDir);
    }
  });
});
