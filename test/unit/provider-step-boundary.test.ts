import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { BudgetExceededError } from '../../src/budget.js';
import type { Provider } from '../../src/providers/base.js';
import { StateManager } from '../../src/state.js';
import { createTestDb } from '../helpers.js';

function makeMockProvider(output = 'mock-result', usage = { inputTokens: 10, outputTokens: 5 }): Provider {
  return {
    execute: async () => ({ output, usage, durationMs: 1 }),
  };
}

function makeContext(opts: {
  concurrency?: number;
  providers?: { anthropic?: Provider };
  budget?: { tokens: number };
}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'provider-boundary-'));
  const runId = `boundary-${Math.random().toString(36).slice(2)}`;
  const db = createTestDb(stateDir);
  const state = new StateManager(db, runId);
  const budgetManager = new BudgetManager(opts.budget);
  const ctx = new Context({
    id: runId,
    concurrency: opts.concurrency ?? 5,
    signal: new AbortController().signal,
    state,
    budgetManager,
    db,
    providers: opts.providers,
  });
  return { ctx, state, stateDir, db, budgetManager };
}

function cleanup(stateDir: string, db: { close(): void }) {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
}

describe('Nesting detection', () => {
  test('ctx.step() nested inside another ctx.step() throws descriptive error', async () => {
    const { ctx, stateDir, db } = makeContext({});

    await assert.rejects(
      () =>
        ctx.step('outer', async () => {
          // Calling ctx.step() inside a step fn — should throw
          return ctx.step('inner', async () => 'inner-result');
        }),
      (err: Error) => {
        assert.ok(err.message.includes('ctx.step() cannot be nested'), `got: ${err.message}`);
        assert.ok(err.message.includes('durability boundary'), `got: ${err.message}`);
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('ctx.step() at top level does not throw', async () => {
    const { ctx, stateDir, db } = makeContext({});

    const result = await ctx.step('top-level', async () => 'ok');
    assert.equal(result, 'ok');

    cleanup(stateDir, db);
  });
});

describe('Provider inside ctx.step()', () => {
  test('provider executes and result is returned', async () => {
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('stepped-result') },
    });

    const result = await ctx.step('my-step', () =>
      ctx.model.anthropic('any-model', 'prompt'),
    );

    assert.equal(result, 'stepped-result');

    cleanup(stateDir, db);
  });

  test('step result is persisted in SQLite', async () => {
    const { ctx, state, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('persisted') },
    });

    await ctx.step('persist-me', () => ctx.model.anthropic('any-model', 'prompt'));

    const cached = state.getStep('persist-me');
    assert.equal(cached, 'persisted');

    cleanup(stateDir, db);
  });

  test('usage is tracked against the enclosing step', async () => {
    const { ctx, state, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('ok', { inputTokens: 42, outputTokens: 18 }) },
    });

    await ctx.step('tracked-step', () => ctx.model.anthropic('any-model', 'prompt'));

    const summary = state.getUsageSummary();
    assert.equal(summary.inputTokens, 42);
    assert.equal(summary.outputTokens, 18);

    cleanup(stateDir, db);
  });

  test('memoized step does not re-invoke provider on second call', async () => {
    let callCount = 0;
    const mockProvider: Provider = {
      execute: async () => {
        callCount++;
        return { output: 'cached', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
      },
    };
    const { ctx, stateDir, db } = makeContext({ providers: { anthropic: mockProvider } });

    await ctx.step('memo', () => ctx.model.anthropic('any-model', 'prompt'));
    assert.equal(callCount, 1);

    await ctx.step('memo', () => ctx.model.anthropic('any-model', 'prompt'));
    assert.equal(callCount, 1, 'provider should not be called again for cached step');

    cleanup(stateDir, db);
  });
});

describe('Provider inside ctx.upsert() run', () => {
  test('provider called in upsert run — executes and upserts result', async () => {
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('analysed') },
    });

    // Create target table
    db.exec('CREATE TABLE analyses (id TEXT PRIMARY KEY, result TEXT)');

    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const count = await ctx.upsert(items, {
      table: 'analyses',
      key: (item) => `analyse-${item.id}`,
      run: async (item) => {
        const result = await ctx.model.anthropic<string>('any-model', `analyse ${item.id}`);
        return { id: item.id, result };
      },
      map: (row) => row as Record<string, unknown>,
    });

    assert.equal(count, 3, 'all 3 items should be upserted');
    const rows = db.prepare('SELECT * FROM analyses').all() as Array<{ id: string; result: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.result === 'analysed'));

    cleanup(stateDir, db);
  });

  test('upsert with provider is memoized per item', async () => {
    let callCount = 0;
    const mockProvider: Provider = {
      execute: async () => {
        callCount++;
        return { output: `result-${callCount}`, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
      },
    };
    const { ctx, stateDir, db } = makeContext({ providers: { anthropic: mockProvider } });

    db.exec('CREATE TABLE memos (id TEXT PRIMARY KEY, val TEXT)');
    const items = [{ id: 'x' }];

    // First run
    await ctx.upsert(items, {
      table: 'memos',
      key: (item) => `memo-${item.id}`,
      run: (item) => ctx.model.anthropic('any-model', `process ${item.id}`),
      map: (result) => ({ id: 'x', val: String(result) }),
    });
    assert.equal(callCount, 1);

    // Second run — same step ID, should hit cache
    await ctx.upsert(items, {
      table: 'memos',
      key: (item) => `memo-${item.id}`,
      run: (item) => ctx.model.anthropic('any-model', `process ${item.id}`),
      map: (result) => ({ id: 'x', val: String(result) }),
    });
    assert.equal(callCount, 1, 'provider should not be called again on resume');

    cleanup(stateDir, db);
  });
});

describe('Provider outside ctx.step()', () => {
  test('provider called directly executes without durability', async () => {
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('raw') },
    });

    const result = await ctx.model.anthropic('any-model', 'prompt');
    assert.equal(result, 'raw');

    cleanup(stateDir, db);
  });

  test('usage accumulates in budget manager even outside a step', async () => {
    const { ctx, budgetManager, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider('ok', { inputTokens: 20, outputTokens: 10 }) },
    });

    assert.equal(budgetManager.totalUsed(), 0);
    await ctx.model.anthropic('any-model', 'prompt');
    assert.equal(budgetManager.totalUsed(), 30);

    cleanup(stateDir, db);
  });

  test('bare provider fan-out respects pipeline concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const slowProvider: Provider = {
      execute: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { output: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10 };
      },
    };
    const { ctx, stateDir, db } = makeContext({
      concurrency: 2,
      providers: { anthropic: slowProvider },
    });

    await Promise.all(
      Array.from({ length: 8 }, () => ctx.model.anthropic('any-model', 'prompt')),
    );

    assert.equal(peak, 2, `bare provider calls should be throttled by limiter; peak was ${peak}`);

    cleanup(stateDir, db);
  });

  test('provider calls inside step do not re-acquire limiter (no self-deadlock at concurrency=1)', async () => {
    const { ctx, stateDir, db } = makeContext({
      concurrency: 1,
      providers: { anthropic: makeMockProvider('ok') },
    });

    // If the provider tried to re-enter the limiter, this would deadlock at concurrency=1.
    const result = await ctx.step('outer', async () => {
      const a = await ctx.model.anthropic('any-model', 'p1');
      const b = await ctx.model.anthropic('any-model', 'p2');
      return [a, b];
    });
    assert.deepEqual(result, ['ok', 'ok']);

    cleanup(stateDir, db);
  });

  test('direct provider call is blocked when global budget is already exceeded', async () => {
    let callCount = 0;
    const mockProvider: Provider = {
      execute: async () => {
        callCount++;
        return { output: 'should-not-run', usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 };
      },
    };
    const { ctx, budgetManager, stateDir, db } = makeContext({
      providers: { anthropic: mockProvider },
      budget: { tokens: 10 },
    });

    budgetManager.consume({ inputTokens: 11, outputTokens: 0 });

    await assert.rejects(
      () => ctx.model.anthropic('any-model', 'prompt'),
      BudgetExceededError,
    );
    assert.equal(callCount, 0, 'provider should not run after budget is exceeded');

    cleanup(stateDir, db);
  });
});
