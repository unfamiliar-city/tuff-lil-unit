import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tuff } from '../../../src/tuff.js';
import { HAS_CLAUDE_CLI, createTempStateDir, cleanupDir } from '../helpers.js';

const test = HAS_CLAUDE_CLI ? it : it.skip;

const MODEL = 'claude-haiku-4-5-20251001';

async function runConcurrentCLI(n: number, stateDir: string): Promise<string[]> {
  const results: string[] = [];
  await tuff(`concurrent-cli-${n}`, { stateDir, concurrency: n }, async (ctx) => {
    const outputs = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        ctx.agent.claudeCode(`job-${i}`, MODEL, `Say exactly: ${i}`)
      )
    );
    for (const output of outputs) {
      if (typeof output === 'string') results.push(output);
    }
  });
  return results;
}

describe('ClaudeCLIProvider concurrency', () => {
  test('20 concurrent CLI steps complete', { timeout: 300_000 }, async () => {
    const n = 20;
    const stateDir = createTempStateDir(`concurrent-${n}`);
    try {
      const results = await runConcurrentCLI(n, stateDir);
      assert.equal(results.length, n, `expected ${n} results, got ${results.length}`);
      for (const output of results) {
        assert.ok(output.length > 0, 'each step output must be non-empty');
      }
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('40 concurrent CLI steps complete', { timeout: 300_000 }, async () => {
    const n = 40;
    const stateDir = createTempStateDir(`concurrent-${n}`);
    try {
      const results = await runConcurrentCLI(n, stateDir);
      assert.equal(results.length, n, `expected ${n} results, got ${results.length}`);
      for (const output of results) {
        assert.ok(output.length > 0, 'each step output must be non-empty');
      }
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('60 concurrent CLI steps complete', { timeout: 300_000 }, async () => {
    const n = 60;
    const stateDir = createTempStateDir(`concurrent-${n}`);
    try {
      const results = await runConcurrentCLI(n, stateDir);
      assert.equal(results.length, n, `expected ${n} results, got ${results.length}`);
      for (const output of results) {
        assert.ok(output.length > 0, 'each step output must be non-empty');
      }
    } finally {
      cleanupDir(stateDir);
    }
  });
});
