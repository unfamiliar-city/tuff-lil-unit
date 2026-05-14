import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuff } from '../../src/tuff.js';
import { BudgetExceededError } from '../../src/budget.js';
import { Context } from '../../src/context.js';
import { StateManager } from '../../src/state.js';
import { BudgetManager } from '../../src/budget.js';
import { createTestDb } from '../helpers.js';

function cleanup(stateDir: string) {
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('Integration: Budget Enforcement', () => {
  it('budget pre-flight in step model — throws before executing when exceeded', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'budget-precheck-test-'));
    let step2Executed = false;

    // Use Context directly to control budget precisely
    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'budget-precheck');
    const budgetManager = new BudgetManager({ tokens: 100 });

    // Consume beyond the budget limit (100 > 100 is false; 101 > 100 is true)
    budgetManager.consume({ inputTokens: 101, outputTokens: 0 });

    const ctx = new Context({
      id: 'budget-precheck',
      concurrency: 5,
      signal: new AbortController().signal,
      state,
      budgetManager,
      db,
    });

    await assert.rejects(
      () =>
        ctx.step('blocked-step', async () => {
          step2Executed = true;
          return 'should-not-run';
        }),
      BudgetExceededError,
    );

    assert.equal(step2Executed, false, 'step should not execute when budget exceeded');

    db.close();
    cleanup(stateDir);
  });

  it('budget consumption via provider helpers — tokens accumulate', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'budget-consume-test-'));

    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'budget-consume');
    const budgetManager = new BudgetManager({ tokens: 1000 });

    const ctx = new Context({
      id: 'budget-consume',
      concurrency: 5,
      signal: new AbortController().signal,
      state,
      budgetManager,
      db,
    });

    // Simulate provider usage by consuming budget manually in step
    await ctx.step('step-with-tokens', async () => {
      // Simulate what provider helpers do: consume budget
      budgetManager.consume({ inputTokens: 100, outputTokens: 50 });
      return 'result';
    });

    assert.equal(budgetManager.totalUsed(), 150, 'tokens should accumulate');
    assert.equal(budgetManager.isExceeded(), false, 'should not be exceeded yet');

    db.close();
    cleanup(stateDir);
  });

  it('budget exceeded mid-fan-out — remaining steps throw BudgetExceededError', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'budget-fanout-test-'));

    const db = createTestDb(stateDir);
    const state = new StateManager(db, 'budget-fanout');
    const budgetManager = new BudgetManager({ tokens: 50 });

    const ctx = new Context({
      id: 'budget-fanout',
      concurrency: 1, // serial so budget is exceeded before last step
      signal: new AbortController().signal,
      state,
      budgetManager,
      db,
    });

    // First step exceeds the budget
    await ctx.step('step-1', async () => {
      budgetManager.consume({ inputTokens: 60, outputTokens: 0 });
      return 'r1';
    });

    // Second step: budget now exceeded, pre-flight should throw
    await assert.rejects(
      () => ctx.step('step-2', async () => 'should-not-run'),
      BudgetExceededError,
    );

    db.close();
    cleanup(stateDir);
  });

  it('tuff() with budget — BudgetExceededError propagates as pipeline error', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'budget-tuff-test-'));

    // Seed prior usage that exceeds budget on resume
    const db = createTestDb(stateDir);
    const seed = new StateManager(db, 'budget-pipeline');
    seed.initRun({});
    seed.setStep('prior-step', 'done', { inputTokens: 20, outputTokens: 0 });
    db.close();

    let thrownError: Error | null = null;

    try {
      await tuff(
        'budget-pipeline',
        { stateDir, concurrency: 5, budget: { tokens: 10 } },
        async (ctx) => {
          // prior-step is cached, budget is already 20/10 (exceeded from restore)
          await ctx.step('prior-step', async () => 'done');
          await ctx.step('new-step', async () => 'fresh');
        },
      );
    } catch (e) {
      thrownError = e as Error;
    }

    assert.ok(thrownError instanceof BudgetExceededError, 'should throw BudgetExceededError');

    cleanup(stateDir);
  });
});
