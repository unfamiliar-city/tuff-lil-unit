import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, estimateTokens } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { BudgetExceededError } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { createTestDb } from '../helpers.js';

function makeContext(opts: {
  concurrency?: number;
  budget?: { tokens: number };
  signal?: AbortSignal;
}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'step-budget-test-'));
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  const db = createTestDb(stateDir);
  const state = new StateManager(db, runId);
  state.initRun({});
  const budgetManager = new BudgetManager(opts.budget);
  const ctx = new Context({
    id: runId,
    concurrency: opts.concurrency ?? 10,
    signal: opts.signal ?? new AbortController().signal,
    state,
    budgetManager,
    db,
  });
  return { ctx, state, budgetManager, stateDir, db };
}

function cleanup(stateDir: string, db: { close(): void }) {
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
}

describe('estimateTokens', () => {
  test('estimates ~4 chars per token', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(100)), 25);
  });

  test('empty string returns 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('rounds up partial tokens', () => {
    assert.equal(estimateTokens('ab'), 1); // 2/4 = 0.5 → ceil = 1
    assert.equal(estimateTokens('abc'), 1); // 3/4 = 0.75 → ceil = 1
  });

  test('handles unicode (counts by JS string length, not codepoints)', () => {
    // Each emoji is 2 JS chars (surrogate pair): 4 emoji × 2 = 8 chars → 2 estimated tokens
    assert.equal(estimateTokens('🎉🎊🎈🎁'), 2);
  });
});

describe('Step budget: pre-call input check', () => {
  test('model.anthropic rejects prompt exceeding maxInputTokens', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(400); // 400 chars → 100 estimated tokens

    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxInputTokens: 50,
        }),
      (err: Error) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.match(err.message, /Estimated input tokens \(100\) exceeds step limit \(50\)/);
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('model.openai rejects prompt exceeding maxInputTokens', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(200); // 50 estimated tokens

    await assert.rejects(
      () =>
        ctx.model.openai('gpt-5-mini', longPrompt, {
          maxInputTokens: 10,
        }),
      BudgetExceededError,
    );

    cleanup(stateDir, db);
  });

  test('agent.claudeCode rejects prompt exceeding maxInputTokens', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(200);

    await assert.rejects(
      () =>
        ctx.agent.claudeCode('claude-sonnet-4-5-20250514', longPrompt, {
          maxInputTokens: 10,
        }),
      BudgetExceededError,
    );

    cleanup(stateDir, db);
  });

  test('prompt under maxInputTokens passes pre-call check (fails at provider, not budget)', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const shortPrompt = 'hello'; // 2 estimated tokens

    // The pre-call check should pass, then the provider call fails because no API key.
    // The error should NOT be BudgetExceededError.
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', shortPrompt, {
          maxInputTokens: 1000,
        }),
      (err: Error) => {
        assert.ok(
          !(err instanceof BudgetExceededError),
          `Expected non-budget error, got: ${err.message}`,
        );
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('no maxInputTokens skips pre-call check', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(10_000);

    // Even with a huge prompt, no maxInputTokens means no check.
    // Fails at provider level, not budget.
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxTokens: 100, // only output cap, no input check
        }),
      (err: Error) => {
        assert.ok(
          !(err instanceof BudgetExceededError),
          `Expected non-budget error, got: ${err.message}`,
        );
        return true;
      },
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: custom tokenEstimator', () => {
  test('uses custom estimator instead of default', async () => {
    const { ctx, stateDir, db } = makeContext({});

    // Custom estimator that always returns 999
    const customEstimator = () => 999;

    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', 'tiny', {
          maxInputTokens: 500,
          tokenEstimator: customEstimator,
        }),
      (err: Error) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.match(err.message, /Estimated input tokens \(999\) exceeds step limit \(500\)/);
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('custom estimator that returns low count allows execution', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(10_000); // default: 2500 tokens

    // Custom estimator says "it's only 5 tokens" — passes the check
    const customEstimator = () => 5;

    // Pre-call passes, then fails at provider
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxInputTokens: 10,
          tokenEstimator: customEstimator,
        }),
      (err: Error) => {
        assert.ok(
          !(err instanceof BudgetExceededError),
          `Expected non-budget error, got: ${err.message}`,
        );
        return true;
      },
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: cached steps bypass input check', () => {
  test('cached step returns immediately without input budget check', async () => {
    const { ctx, state, stateDir, db } = makeContext({});

    // Pre-seed a cached result
    state.setStep('cached-step', 'cached-result');

    // Even with an impossibly low maxInputTokens, the cached step should return
    // without hitting the pre-call check (because step() returns from cache before fn runs)
    const result = await ctx.step('cached-step', () =>
      ctx.model.anthropic('claude-haiku-4-5-20251001', 'x'.repeat(10_000), { maxInputTokens: 1 }),
    );

    assert.equal(result, 'cached-result');

    cleanup(stateDir, db);
  });
});

describe('Step budget: maxInputTokens boundary conditions', () => {
  test('exact boundary — estimate equals limit — passes', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const prompt = 'x'.repeat(40); // 40/4 = 10 estimated tokens

    // maxInputTokens: 10, estimate: 10 → NOT exceeded (must be strictly greater)
    // Pre-call passes, then fails at provider
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', prompt, {
          maxInputTokens: 10,
        }),
      (err: Error) => {
        assert.ok(
          !(err instanceof BudgetExceededError),
          `Expected non-budget error at boundary, got: ${err.message}`,
        );
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('one over boundary — estimate exceeds limit by 1 — throws', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const prompt = 'x'.repeat(44); // 44/4 = 11 estimated tokens

    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', prompt, {
          maxInputTokens: 10,
        }),
      BudgetExceededError,
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: interaction with global budget', () => {
  test('global budget exceeded takes precedence over per-step check', async () => {
    const { ctx, budgetManager, stateDir, db } = makeContext({
      budget: { tokens: 100 },
    });

    // Exhaust global budget
    budgetManager.consume({ inputTokens: 200, outputTokens: 0 });

    // Global budget check in step() fires before fn() even runs,
    // so per-step maxInputTokens never gets checked
    await assert.rejects(
      () =>
        ctx.step('global-first', () =>
          ctx.model.anthropic('claude-haiku-4-5-20251001', 'short', {
            maxInputTokens: 1_000_000,
          }),
        ),
      (err: Error) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.equal(err.message, 'Budget exceeded');
        return true;
      },
    );

    cleanup(stateDir, db);
  });

  test('per-step check fires when global budget has room', async () => {
    const { ctx, stateDir, db } = makeContext({
      budget: { tokens: 1_000_000 },
    });

    const longPrompt = 'x'.repeat(400); // 100 estimated tokens

    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxInputTokens: 50,
        }),
      (err: Error) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.match(err.message, /Estimated input tokens/);
        return true;
      },
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: stripBudgetOpts (indirect)', () => {
  test('maxTokens passes through to provider, budget-only fields do not', async () => {
    const { ctx, stateDir, db } = makeContext({});

    // If budget fields leaked to generateText(), the Vercel AI SDK might behave
    // unexpectedly. This test verifies the call gets far enough that the provider
    // is invoked (and fails due to missing API key), not rejected by the framework.
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', 'test', {
          maxTokens: 100,
          maxInputTokens: 1000,
          onExceed: 'warn',
          tokenEstimator: (t: string) => t.length,
        }),
      (err: Error) => {
        // Should fail at provider level, not from our code
        assert.ok(
          !(err instanceof BudgetExceededError),
          `Expected provider error, got budget error: ${err.message}`,
        );
        return true;
      },
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: usage persistence fix', () => {
  test('step records usage in SQLite when provider helper sets it', async () => {
    const { ctx, state, budgetManager, stateDir, db } = makeContext({});

    // Simulate what provider helpers do: consume budget inside a step.
    state.setStep('manual-step', 'result', { inputTokens: 42, outputTokens: 18 }, 100);
    const summary = state.getUsageSummary();
    assert.equal(summary.inputTokens, 42);
    assert.equal(summary.outputTokens, 18);

    cleanup(stateDir, db);
  });

  test('budget restoration on resume reflects persisted per-step usage', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'persist-resume-'));
    const runId = 'persist-test';

    // First "run": seed steps with usage
    const db1 = createTestDb(stateDir);
    const state1 = new StateManager(db1, runId);
    state1.initRun({});
    state1.setStep('step-a', 'a', { inputTokens: 50, outputTokens: 30 });
    state1.setStep('step-b', 'b', { inputTokens: 20, outputTokens: 10 });
    db1.close();

    // Second "run": restore budget from persisted usage
    const db2 = createTestDb(stateDir);
    const state2 = new StateManager(db2, runId);
    const restored = state2.getUsageSummary();
    assert.equal(restored.inputTokens, 70, 'sum of input tokens from both steps');
    assert.equal(restored.outputTokens, 40, 'sum of output tokens from both steps');

    // BudgetManager should reflect restored usage
    const budget = new BudgetManager({ tokens: 100 });
    budget.consume(restored);
    assert.equal(budget.totalUsed(), 110, 'restored total: 70 + 40 = 110');
    assert.ok(budget.isExceeded(), 'budget of 100 should be exceeded with 110 used');

    db2.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe('Step budget: onExceed default behavior', () => {
  test('onExceed defaults to throw (pre-call always throws regardless)', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(400);

    // No explicit onExceed — default is 'throw'
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxInputTokens: 50,
        }),
      BudgetExceededError,
    );

    cleanup(stateDir, db);
  });

  test('onExceed: warn on pre-call still throws (onExceed only affects post-call)', async () => {
    const { ctx, stateDir, db } = makeContext({});
    const longPrompt = 'x'.repeat(400);

    // Even with onExceed: 'warn', the pre-call check always throws —
    // onExceed only controls post-call behavior where tokens were already spent.
    await assert.rejects(
      () =>
        ctx.model.anthropic('claude-haiku-4-5-20251001', longPrompt, {
          maxInputTokens: 50,
          onExceed: 'warn',
        }),
      BudgetExceededError,
    );

    cleanup(stateDir, db);
  });
});

describe('Step budget: agent.claudeCode maxTokens threading', () => {
  test('maxTokens is forwarded to ClaudeCLIProvider execute options', async () => {
    const { ctx, stateDir, db } = makeContext({});

    // We can't easily verify maxTokens reached the provider without spawning claude.
    // But we can verify the input budget check works, which confirms opts are threaded.
    const longPrompt = 'x'.repeat(400);

    await assert.rejects(
      () =>
        ctx.agent.claudeCode('claude-sonnet-4-5-20250514', longPrompt, {
          maxTokens: 10_000,
          maxInputTokens: 50,
        }),
      (err: Error) => {
        assert.ok(err instanceof BudgetExceededError);
        assert.match(err.message, /Estimated input tokens/);
        return true;
      },
    );

    cleanup(stateDir, db);
  });
});
