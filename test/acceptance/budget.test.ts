import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Context } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { BudgetExceededError } from '../../src/budget.js';
import type { Provider } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { syncSchema } from '../../src/schema-sync.js';
import { SCHEMA_SQL } from '../../src/schema.js';
import { makeTempDir, cleanup } from './helpers.js';

// Mock provider: 400 input + 200 output = 600 total tokens per call
function makeMockProvider(): Provider {
  return {
    execute: async () => ({
      output: 'ok',
      usage: { inputTokens: 400, outputTokens: 200 },
      durationMs: 1,
    }),
  };
}

describe('J5 — Budget exceeded → increase → resume', () => {
  test('budget exhausted mid-pipeline; re-run with higher budget resumes from failure point', async () => {
    const stateDir = makeTempDir();

    try {
      // Setup: init DB
      const db = new Database(`${stateDir}/tuff.db`);
      db.pragma('journal_mode = WAL');
      syncSchema(db, SCHEMA_SQL);
      const runId = 'j5';
      const mockProvider = makeMockProvider();

      const runPipeline = (budgetTokens: number) => {
        // Restore prior usage from DB on each run (mirrors tuff() behavior)
        const state = new StateManager(db, runId);
        const budgetManager = new BudgetManager({ tokens: budgetTokens });
        const priorUsage = state.getUsageSummary();
        if (priorUsage.inputTokens > 0 || priorUsage.outputTokens > 0) {
          budgetManager.consume(priorUsage);
        }

        const ctx = new Context({
          id: runId,
          concurrency: 3,
          signal: new AbortController().signal,
          state,
          budgetManager,
          db,
          providers: { anthropic: mockProvider },
        });

        return ctx;
      };

      // Run 1: budget=1000, each model call consumes 600 tokens
      // After step-1 (600 used): 600 > 1000 = false → runs
      // After step-2 (1200 used): 1200 > 1000 = true → step-3 blocked
      const ctx1 = runPipeline(1000);
      await ctx1.model.anthropic('step-1', 'model', 'prompt');
      await ctx1.model.anthropic('step-2', 'model', 'prompt');
      // step-3 should throw because budget is exceeded (1200 > 1000)
      await assert.rejects(
        () => ctx1.model.anthropic('step-3', 'model', 'prompt'),
        BudgetExceededError,
      );

      // Verify run 1 state: steps 1-2 in DB, budget exceeded
      const step1 = db.prepare('SELECT step_id FROM tuff_steps WHERE run_id=? AND step_id=?').get('j5', 'step-1');
      const step2 = db.prepare('SELECT step_id FROM tuff_steps WHERE run_id=? AND step_id=?').get('j5', 'step-2');
      assert.ok(step1, 'step-1 should be persisted');
      assert.ok(step2, 'step-2 should be persisted');

      // Run 2: budget=5000 — prior usage (1200) restored, headroom=3800
      const ctx2 = runPipeline(5000);
      const r1 = await ctx2.model.anthropic('step-1', 'model', 'prompt');
      const r2 = await ctx2.model.anthropic('step-2', 'model', 'prompt');
      const r3 = await ctx2.model.anthropic('step-3', 'model', 'prompt');
      const r4 = await ctx2.model.anthropic('step-4', 'model', 'prompt');
      const r5 = await ctx2.model.anthropic('step-5', 'model', 'prompt');

      // Steps 1-2 return cached value 'ok' (not 'resumed') since they were cached
      assert.equal(r1, 'ok', 'step-1 should return cached value');
      assert.equal(r2, 'ok', 'step-2 should return cached value');
      // Steps 3-5 are new — they execute and return 'ok' from the mock provider
      assert.equal(r3, 'ok');
      assert.equal(r4, 'ok');
      assert.equal(r5, 'ok');

      db.close();
    } finally {
      cleanup(stateDir);
    }
  });
});
