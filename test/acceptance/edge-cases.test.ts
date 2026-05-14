import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { tuff } from '../../src/tuff.js';
import { makeTempDir, cleanup } from './helpers.js';

describe('Edge cases', () => {
  test('duplicate step IDs — both return first result, second fn never called', async () => {
    const stateDir = makeTempDir();
    let secondCallCount = 0;

    try {
      const result = await tuff('edge-dup', { stateDir, concurrency: 1 }, async (ctx) => {
        const r1 = await ctx.step('same-id', async () => 'first');
        const r2 = await ctx.step('same-id', async () => {
          secondCallCount++;
          return 'second';
        });
        return { r1, r2 };
      });

      assert.equal(result.r1, 'first');
      assert.equal(result.r2, 'first', 'second call should return first result (cached)');
      assert.equal(secondCallCount, 0, 'second fn should never be called');
    } finally {
      cleanup(stateDir);
    }
  });

  test('step returning null — null cached, fn not re-called on second run', async () => {
    const stateDir = makeTempDir();
    let callCount = 0;

    const runPipeline = () =>
      tuff('edge-null', { stateDir, concurrency: 1 }, async (ctx) =>
        ctx.step('x', async () => { callCount++; return null; }),
      );

    try {
      const r1 = await runPipeline();
      assert.equal(r1, null);
      assert.equal(callCount, 1);

      callCount = 0;
      const r2 = await runPipeline();
      assert.equal(r2, null, 'null should be cached');
      assert.equal(callCount, 0, 'fn should not re-execute when null is cached');
    } finally {
      cleanup(stateDir);
    }
  });

  test('JSON fidelity — complex value deep-equals original after cache round-trip', async () => {
    const stateDir = makeTempDir();
    const complex = { n: null, z: 0, f: false, e: '', arr: [1, null, 'x'] };

    const runPipeline = () =>
      tuff('edge-json', { stateDir, concurrency: 1 }, async (ctx) =>
        ctx.step('fidelity', async () => complex),
      );

    try {
      await runPipeline(); // first run: execute and cache
      const cached = await runPipeline(); // second run: return from cache

      assert.deepEqual(cached, complex, 'cached value should deep-equal original');
      assert.equal((cached as typeof complex).n, null, 'null should be null, not undefined');
      assert.equal((cached as typeof complex).z, 0, 'zero should be preserved');
      assert.equal((cached as typeof complex).f, false, 'false should be preserved');
      assert.equal((cached as typeof complex).e, '', 'empty string should be preserved');
      assert.deepEqual((cached as typeof complex).arr, [1, null, 'x'], 'array should be preserved');
    } finally {
      cleanup(stateDir);
    }
  });
});
