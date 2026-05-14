import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';

function cleanup(stateDir: string) {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('Integration: Parallel Execution', () => {
  it('fan-out concurrency with p-limit — verify N concurrent max', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'parallel-test-'));

    let currentlyRunning = 0;
    let maxConcurrent = 0;

    await tuff(
      'parallel-run',
      { stateDir, concurrency: 4 },
      async (ctx) => {
        return Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            ctx.step(`step-${i}`, async () => {
              currentlyRunning++;
              maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
              await new Promise((resolve) => setTimeout(resolve, 20));
              currentlyRunning--;
              return i;
            })
          )
        );
      }
    );

    assert.ok(maxConcurrent <= 4, `max concurrent was ${maxConcurrent}, expected <= 4`);
    assert.ok(maxConcurrent >= 2, `expected some parallelism, got ${maxConcurrent}`);

    cleanup(stateDir);
  });

  it('fan-out failure — error propagates as pipeline rejection', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'abort-fanout-test-'));
    let failDidRun = false;

    await assert.rejects(
      () =>
        tuff(
          'abort-fanout',
          { stateDir, concurrency: 2 },
          async (ctx) => {
            // Promise.all: one step failure causes the whole fan-out to fail
            await Promise.all([
              ctx.step('step-ok', async () => 'ok'),
              ctx.step('step-fail', async () => {
                failDidRun = true;
                throw new Error('intentional failure');
              }),
            ]);
          }
        ),
      /intentional failure/
    );

    assert.ok(failDidRun, 'failing step should have run');

    cleanup(stateDir);
  });

  it('Promise.allSettled tolerance — partial failure without abort', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'allsettled-test-'));
    const executedSteps: string[] = [];

    const result = await tuff(
      'allsettled-run',
      { stateDir, concurrency: 5 },
      async (ctx) => {
        // Use Promise.allSettled — failures don't abort siblings
        const results = await Promise.allSettled([
          ctx.step('s1', async () => { executedSteps.push('s1'); return 'ok-1'; }),
          ctx.step('s2', async () => { executedSteps.push('s2'); throw new Error('s2 failed'); }),
          ctx.step('s3', async () => { executedSteps.push('s3'); return 'ok-3'; }),
          ctx.step('s4', async () => { executedSteps.push('s4'); return 'ok-4'; }),
        ]);

        return results.map((r) => (r.status === 'fulfilled' ? r.value : null));
      }
    );

    // All 4 steps should have been attempted (allSettled doesn't abort)
    assert.equal(executedSteps.length, 4);
    assert.deepEqual(result, ['ok-1', null, 'ok-3', 'ok-4']);

    cleanup(stateDir);
  });

  it('sequential fan-in — steps execute in dependency order', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fanin-test-'));
    const order: string[] = [];

    const result = await tuff(
      'fanin-run',
      { stateDir, concurrency: 10 },
      async (ctx) => {
        // Fan-out
        const [a, b, c] = await Promise.all([
          ctx.step('a', async () => { order.push('a'); return 1; }),
          ctx.step('b', async () => { order.push('b'); return 2; }),
          ctx.step('c', async () => { order.push('c'); return 3; }),
        ]);

        // Fan-in
        const sum = await ctx.step('sum', async () => {
          order.push('sum');
          return a + b + c;
        });

        return sum;
      }
    );

    assert.equal(result, 6);
    assert.equal(order[order.length - 1], 'sum', 'sum should be last');
    assert.ok(order.includes('a') && order.includes('b') && order.includes('c'));
    assert.ok(
      order.indexOf('a') < order.indexOf('sum') &&
      order.indexOf('b') < order.indexOf('sum') &&
      order.indexOf('c') < order.indexOf('sum'),
      'all fan-out steps should run before fan-in'
    );

    cleanup(stateDir);
  });
});
