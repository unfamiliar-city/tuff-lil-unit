import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';
import { StateManager } from '../../src/state.js';
import { createTestDb } from '../helpers.js';

function cleanup(stateDir: string) {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('Integration: Crash Recovery', () => {
  it('resume with step cache — completed steps skip, new steps execute', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crash-recovery-test-'));
    const executionCounts: Record<string, number> = {};

    for (let i = 0; i < 10; i++) {
      executionCounts[`step-${i}`] = 0;
    }

    const runPipeline = () =>
      tuff(
        'crash-test',
        { stateDir, concurrency: 2, handleProcessSignals: true },
        async (ctx) => {
          return Promise.all(
            Array.from({ length: 10 }, (_, i) =>
              ctx.step(`step-${i}`, async () => {
                executionCounts[`step-${i}`]++;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return `result-${i}`;
              }),
            ),
          );
        },
      );

    // First run: abort partway through
    const run1Promise = runPipeline();
    setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 50);
    await assert.rejects(() => run1Promise);

    // Use SQLite to determine what was actually persisted
    const run1Db = createTestDb(stateDir);
    const run1State = new StateManager(run1Db, 'crash-test');
    const completedInRun1 = Array.from({ length: 10 }, (_, i) => `step-${i}`).filter(
      (id) => run1State.getStep(id) !== undefined,
    );
    run1Db.close();

    assert.ok(completedInRun1.length > 0, 'some steps should complete in first run');
    assert.ok(completedInRun1.length < 10, 'not all steps should complete in first run');

    // Reset counts to verify resume behavior
    for (const key of Object.keys(executionCounts)) {
      executionCounts[key as keyof typeof executionCounts] = 0;
    }

    // Second run: all steps complete
    const results = await runPipeline();
    assert.equal(results.length, 10);

    // Steps that completed in first run must NOT re-execute
    for (const stepId of completedInRun1) {
      assert.equal(
        executionCounts[stepId],
        0,
        `${stepId} should not re-execute (cached from run 1)`,
      );
    }

    // Total executions across both runs: each step executes exactly once
    for (let i = 0; i < 10; i++) {
      const id = `step-${i}`;
      const ranInRun1 = completedInRun1.includes(id);
      assert.equal(
        executionCounts[id],
        ranInRun1 ? 0 : 1,
        `${id} should have executed exactly once total`,
      );
    }

    cleanup(stateDir);
  });

  it('failure persistence across crash — step_failures table survives restart', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'failure-persist-test-'));

    // Run that fails
    await assert.rejects(
      () =>
        tuff(
          'failure-persist-run',
          { stateDir, concurrency: 5 },
          async (ctx) => {
            await ctx.step('good-step', async () => 'ok');
            await ctx.step('bad-step', async () => {
              throw new Error('permanent failure');
            });
          },
        ),
      /permanent failure/,
    );

    // Open DB directly to verify failure persisted
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'failure-persist-run');
    const failure = state.getStepFailure('bad-step');
    assert.ok(failure, 'bad-step failure should persist');
    assert.ok(failure.error.includes('permanent failure'));

    // good-step should be cached
    const goodResult = state.getStep('good-step');
    assert.equal(goodResult, 'ok');

    db.close();
    cleanup(stateDir);
  });

  it('partial fan-out resume — some steps cached, others re-execute', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'partial-fanout-test-'));
    const executionCounts: Record<string, number> = {};

    for (let i = 0; i < 5; i++) {
      executionCounts[`fan-${i}`] = 0;
    }

    const runFanOut = () =>
      tuff(
        'partial-fanout',
        { stateDir, concurrency: 1, handleProcessSignals: true }, // serial so abort stops early
        async (ctx) => {
          return Promise.all(
            Array.from({ length: 5 }, (_, i) =>
              ctx.step(`fan-${i}`, async () => {
                executionCounts[`fan-${i}`]++;
                await new Promise((resolve) => setTimeout(resolve, 30));
                return i;
              }),
            ),
          );
        },
      );

    // First run: abort after ~1 step with concurrency=1
    const run1 = runFanOut();
    setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 40);
    await assert.rejects(() => run1);

    // Query SQLite to find which steps were actually persisted
    const run1Db = createTestDb(stateDir);
    const run1State = new StateManager(run1Db, 'partial-fanout');
    const cachedAfterRun1 = Array.from({ length: 5 }, (_, i) => `fan-${i}`).filter(
      (id) => run1State.getStep(id) !== undefined,
    );
    run1Db.close();

    assert.ok(cachedAfterRun1.length > 0, 'some steps should be cached');
    assert.ok(cachedAfterRun1.length < 5, 'not all steps should be cached');

    // Reset counts
    for (const key of Object.keys(executionCounts)) {
      executionCounts[key] = 0;
    }

    // Second run: completes all, re-executes only uncached ones
    const results = await runFanOut();
    assert.equal(results.length, 5);

    // Verify steps persisted from run 1 were NOT re-executed in run 2
    for (const id of cachedAfterRun1) {
      assert.equal(executionCounts[id], 0, `${id} cached, should not re-run`);
    }

    cleanup(stateDir);
  });
});
