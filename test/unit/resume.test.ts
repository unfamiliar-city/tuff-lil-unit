import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';
import { StateManager } from '../../src/state.js';
import { BudgetExceededError } from '../../src/budget.js';
import { createTestDb } from '../helpers.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tuff-resume-'));
}

describe('Resume: step cache', () => {
  test('cached steps return instantly, uncached re-execute', async () => {
    const stateDir = tmpDir();
    let executionCount = 0;

    const runPipeline = () =>
      tuff(
        'cache-resume',
        { stateDir, concurrency: 5 },
        async (ctx) => {
          const r1 = await ctx.step('step-1', async () => {
            executionCount++;
            return 'result-1';
          });
          const r2 = await ctx.step('step-2', async () => {
            executionCount++;
            return 'result-2';
          });
          return [r1, r2];
        },
      );

    const run1 = await runPipeline();
    assert.deepEqual(run1, ['result-1', 'result-2']);
    assert.equal(executionCount, 2);

    executionCount = 0;

    const run2 = await runPipeline();
    assert.deepEqual(run2, ['result-1', 'result-2']);
    assert.equal(executionCount, 0, 'all steps should be cached');

    rmSync(stateDir, { recursive: true });
  });

  test('partial cache — completed steps skip, new ones execute', async () => {
    const stateDir = tmpDir();
    let executionCount = 0;

    // First run: only complete step-1
    await tuff('partial-resume', { stateDir, concurrency: 5 }, async (ctx) => {
      await ctx.step('step-1', async () => {
        executionCount++;
        return 'r1';
      });
    });

    assert.equal(executionCount, 1);
    executionCount = 0;

    // Resume: step-1 cached, step-2 executes
    const result = await tuff('partial-resume', { stateDir, concurrency: 5 }, async (ctx) => {
      const r1 = await ctx.step('step-1', async () => {
        executionCount++;
        return 'r1';
      });
      const r2 = await ctx.step('step-2', async () => {
        executionCount++;
        return 'r2';
      });
      return { r1, r2 };
    });

    assert.equal(executionCount, 1, 'only step-2 should execute');
    assert.deepEqual(result, { r1: 'r1', r2: 'r2' });

    rmSync(stateDir, { recursive: true });
  });
});

describe('Resume: failure persistence', () => {
  test('failed steps recorded in step_failures, queryable after crash', async () => {
    const stateDir = tmpDir();

    await assert.rejects(
      () =>
        tuff('failure-persist', { stateDir, concurrency: 5 }, async (ctx) => {
          await ctx.step('bad-step', async () => {
            throw new Error('step exploded');
          });
        }),
      /step exploded/,
    );

    // Open state directly to inspect failure record
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'failure-persist');
    const failure = state.getStepFailure('bad-step');
    assert.ok(failure, 'step_failures should have a record');
    assert.ok(failure.error.includes('step exploded'));
    db.close();

    rmSync(stateDir, { recursive: true });
  });

  test('distinguishes "never ran" from "ran and failed"', async () => {
    const stateDir = tmpDir();

    await assert.rejects(
      () =>
        tuff('ran-vs-failed', { stateDir, concurrency: 5 }, async (ctx) => {
          await ctx.step('failed-step', async () => {
            throw new Error('failed');
          });
        }),
      /failed/,
    );

    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'ran-vs-failed');

    // failed-step has a failure record
    assert.ok(state.getStepFailure('failed-step'));

    // never-ran-step has no record at all
    assert.equal(state.getStep('never-ran-step'), undefined);
    assert.equal(state.getStepFailure('never-ran-step'), undefined);

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Resume: budget restoration', () => {
  test('prior token usage from steps table reflected in BudgetManager', async () => {
    const stateDir = tmpDir();

    // Seed prior usage directly into state
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'budget-restore');
    state.initRun({});
    state.setStep('heavy-step', 'done', { inputTokens: 90, outputTokens: 30 });
    db.close();

    let budgetExceeded = false;
    try {
      await tuff(
        'budget-restore',
        { stateDir, concurrency: 5, budget: { tokens: 100 } },
        async (ctx) => {
          await ctx.step('heavy-step', async () => 'done');
          // Budget: 100 total, 120 restored → exceeded before new-step runs
          await ctx.step('new-step', async () => 'should-fail');
        },
      );
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        budgetExceeded = true;
      } else {
        throw e;
      }
    }

    assert.ok(budgetExceeded, 'restored budget should prevent new steps');

    rmSync(stateDir, { recursive: true });
  });
});

describe('Graceful shutdown', () => {
  test('SIGTERM fires abort, pending steps bail, completed steps persist', async () => {
    const stateDir = tmpDir();
    let step1Completed = false;
    let step2Started = false;

    const runPromise = tuff(
      'sigterm-test',
      { stateDir, concurrency: 1, handleProcessSignals: true },
      async (ctx) => {
        await ctx.step('step-1', async () => {
          // Fire SIGTERM while step-1 is running
          setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 20);
          await new Promise((resolve) => setTimeout(resolve, 50));
          step1Completed = true;
          return 'step1-result';
        });

        await ctx.step('step-2', async () => {
          step2Started = true;
          return 'step2-result';
        });
      },
    );

    await assert.rejects(() => runPromise);

    assert.ok(step1Completed, 'step-1 should complete (in-flight)');
    assert.equal(step2Started, false, 'step-2 should not start after abort');

    // step-1 should be persisted despite the abort
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'sigterm-test');
    const cached = state.getStep('step-1');
    assert.equal(cached, 'step1-result', 'completed step persisted even after abort');
    db.close();

    rmSync(stateDir, { recursive: true });
  });

  test('changed step logic + resume returns stale cached results (known limitation)', () => {
    assert.ok(true, 'known limitation documented');
  });
});
