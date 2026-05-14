import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';
import { createTestDb } from '../helpers.js';
import { StateManager } from '../../src/state.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'tuff-test-'));
}

describe('tuff() input validation', () => {
  test('rejects empty id', async () => {
    await assert.rejects(
      () => tuff('', { stateDir: tmpDir() }, async () => 'x'),
      /id must be a non-empty string/,
    );
  });

  test('rejects missing stateDir', async () => {
    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => tuff('valid-id', { stateDir: '' } as any, async () => 'x'),
      /stateDir is required/,
    );
  });

  test('rejects non-integer concurrency', async () => {
    await assert.rejects(
      () => tuff('valid-id', { stateDir: tmpDir(), concurrency: 2.5 }, async () => 'x'),
      /concurrency must be a positive integer/,
    );
  });

  test('rejects zero concurrency', async () => {
    await assert.rejects(
      () => tuff('valid-id', { stateDir: tmpDir(), concurrency: 0 }, async () => 'x'),
      /concurrency must be a positive integer/,
    );
  });

  test('rejects negative budget tokens', async () => {
    await assert.rejects(
      () => tuff('valid-id', { stateDir: tmpDir(), budget: { tokens: -5 } }, async () => 'x'),
      /budget\.tokens must be positive/,
    );
  });

  test('rejects zero budget tokens', async () => {
    await assert.rejects(
      () => tuff('valid-id', { stateDir: tmpDir(), budget: { tokens: 0 } }, async () => 'x'),
      /budget\.tokens must be positive/,
    );
  });
});

describe('tuff()', () => {
  test('returns fn result on success', async () => {
    const stateDir = tmpDir();

    const result = await tuff(
      'success-run',
      { stateDir, concurrency: 2 },
      async (ctx) => {
        const a = await ctx.step('step-a', async () => 'hello');
        const b = await ctx.step('step-b', async () => 'world');
        return `${a} ${b}`;
      },
    );

    assert.equal(result, 'hello world');
    rmSync(stateDir, { recursive: true });
  });

  test('re-throws fn error', async () => {
    const stateDir = tmpDir();

    await assert.rejects(
      () =>
        tuff(
          'error-run',
          { stateDir, concurrency: 2 },
          async () => {
            throw new Error('pipeline failed');
          },
        ),
      /pipeline failed/,
    );

    rmSync(stateDir, { recursive: true });
  });

  test('state cleanup — ctx.step() throws after tuff() returns (DB closed)', async () => {
    const stateDir = tmpDir();
    let ctxRef: import('../../src/context.js').Context | null = null;

    await assert.rejects(
      () =>
        tuff(
          'cleanup-run',
          { stateDir, concurrency: 2 },
          async (ctx) => {
            ctxRef = ctx;
            throw new Error('boom');
          },
        ),
      /boom/,
    );

    assert.ok(ctxRef !== null);

    // After tuff() returns (finally ran), the DB is closed.
    // Attempting any state operation should throw because the DB connection is gone.
    await assert.rejects(
      async () => ctxRef!.step('test', async () => 'x'),
      Error,
    );

    rmSync(stateDir, { recursive: true });
  });

  test('resume detection — second call with same id skips cached steps', async () => {
    const stateDir = tmpDir();
    let executionCount = 0;

    await tuff(
      'resumable',
      { stateDir, concurrency: 2 },
      async (ctx) => {
        await ctx.step('cached', async () => {
          executionCount++;
          return 'result';
        });
      },
    );

    assert.equal(executionCount, 1);

    // Resume — same id, step should be cached
    await tuff(
      'resumable',
      { stateDir, concurrency: 2 },
      async (ctx) => {
        await ctx.step('cached', async () => {
          executionCount++;
          return 'result';
        });
      },
    );

    assert.equal(executionCount, 1, 'step should not re-execute on resume');

    rmSync(stateDir, { recursive: true });
  });

  test('budget restoration on resume — prior token usage reflected in BudgetManager', async () => {
    const stateDir = tmpDir();

    // First run: complete a step with token usage manually recorded
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'budget-resume');
    state.initRun({});
    state.setStep('big-step', 'done', { inputTokens: 80, outputTokens: 30 });
    db.close();

    // Resume with tight budget — prior 110 tokens should be restored
    let budgetExceeded = false;
    try {
      await tuff(
        'budget-resume',
        { stateDir, concurrency: 2, budget: { tokens: 100 } },
        async (ctx) => {
          // big-step is cached, so it doesn't consume more tokens
          await ctx.step('big-step', async () => 'done');
          // But budget should already be exceeded from restored usage (110 > 100)
          await ctx.step('new-step', async () => 'fresh work');
        },
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'BudgetExceededError') {
        budgetExceeded = true;
      } else {
        throw e;
      }
    }

    assert.ok(budgetExceeded, 'budget should be exceeded after restoring 110 prior tokens');

    rmSync(stateDir, { recursive: true });
  });

  test('does not register signal handlers by default', async () => {
    const stateDir = tmpDir();
    const originalListenerCount = process.listenerCount('SIGTERM');

    await tuff(
      'no-signals',
      { stateDir, concurrency: 1 },
      async () => {
        assert.equal(
          process.listenerCount('SIGTERM'),
          originalListenerCount,
          'SIGTERM listener count should not increase',
        );
        return 'done';
      },
    );

    rmSync(stateDir, { recursive: true });
  });

  test('registers signal handlers when handleProcessSignals is true', async () => {
    const stateDir = tmpDir();
    const originalListenerCount = process.listenerCount('SIGTERM');

    await tuff(
      'with-signals',
      { stateDir, concurrency: 1, handleProcessSignals: true },
      async () => {
        assert.equal(
          process.listenerCount('SIGTERM'),
          originalListenerCount + 1,
          'SIGTERM listener count should increase by 1',
        );
        return 'done';
      },
    );

    // After tuff returns, handler should be cleaned up
    assert.equal(process.listenerCount('SIGTERM'), originalListenerCount);

    rmSync(stateDir, { recursive: true });
  });

  test('catch block aborts controller on fn error', async () => {
    const stateDir = tmpDir();
    let step2Executed = false;

    await assert.rejects(
      () =>
        tuff(
          'abort-on-error',
          { stateDir, concurrency: 1 },
          async (ctx) => {
            await ctx.step('step1', async () => {
              throw new Error('fail');
            });
            // With concurrency=1 and abort on error, step2 should be aborted
            await ctx.step('step2', async () => {
              step2Executed = true;
              return 'nope';
            });
          },
        ),
      /fail/,
    );

    assert.equal(step2Executed, false, 'step2 should not execute after abort');

    rmSync(stateDir, { recursive: true });
  });
});
