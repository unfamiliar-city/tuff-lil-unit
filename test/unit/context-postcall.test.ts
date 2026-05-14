import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { Context } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { BudgetExceededError } from '../../src/budget.js';
import type { Provider } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { createTestDb } from '../helpers.js';

function makeMockProvider(usage = { inputTokens: 200, outputTokens: 150 }): Provider {
  return {
    execute: async () => ({ output: 'ok', usage, durationMs: 1 }),
  };
}

function makeContext(opts: {
  concurrency?: number;
  providers?: { anthropic?: Provider };
  budget?: { tokens: number };
}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ctx-postcall-'));
  const runId = `postcall-${Math.random().toString(36).slice(2)}`;
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
  return { ctx, state, stateDir, db };
}

describe('Context post-call budget check', () => {
  test('onExceed:warn + maxInputTokens exceeded — resolves and warns', async () => {
    // usage.inputTokens=200 > maxInputTokens=100
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider({ inputTokens: 200, outputTokens: 150 }) },
    });

    const warnSpy = mock.method(console, 'warn', () => {});

    const result = await ctx.model.anthropic('step1', 'any-model', 'prompt', {
      maxInputTokens: 100,
      onExceed: 'warn',
    });

    assert.equal(result, 'ok', 'should still resolve despite budget warning');
    assert.equal(warnSpy.mock.calls.length, 1, 'console.warn should be called once');
    assert.ok(
      String(warnSpy.mock.calls[0]?.arguments[0]).includes('exceeded budget'),
      'warn message should mention budget',
    );

    warnSpy.mock.restore();
    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('onExceed:throw (default) + maxInputTokens exceeded — rejects with BudgetExceededError', async () => {
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider({ inputTokens: 200, outputTokens: 150 }) },
    });

    await assert.rejects(
      () => ctx.model.anthropic('step2', 'any-model', 'prompt', { maxInputTokens: 100 }),
      BudgetExceededError,
    );

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('maxTokens exceeded (output tokens) — rejects with BudgetExceededError', async () => {
    // usage.outputTokens=150 > maxTokens=50
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider({ inputTokens: 200, outputTokens: 150 }) },
    });

    await assert.rejects(
      () => ctx.model.anthropic('step3', 'any-model', 'prompt', { maxTokens: 50 }),
      BudgetExceededError,
    );

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('both within limits — resolves normally', async () => {
    const { ctx, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider({ inputTokens: 200, outputTokens: 150 }) },
    });

    const result = await ctx.model.anthropic('step4', 'any-model', 'prompt', {
      maxInputTokens: 300,
      maxTokens: 200,
    });

    assert.equal(result, 'ok');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('onExceed:warn path — step is persisted in state after warn fires', async () => {
    const { ctx, state, stateDir, db } = makeContext({
      providers: { anthropic: makeMockProvider({ inputTokens: 200, outputTokens: 150 }) },
    });

    const warnSpy = mock.method(console, 'warn', () => {});

    await ctx.model.anthropic('step5', 'any-model', 'prompt', {
      maxInputTokens: 100,
      onExceed: 'warn',
    });

    const cached = state.getStep('step5');
    assert.equal(cached, 'ok', 'step result should be persisted even when budget warn fires');

    warnSpy.mock.restore();
    db.close();
    rmSync(stateDir, { recursive: true });
  });
});
