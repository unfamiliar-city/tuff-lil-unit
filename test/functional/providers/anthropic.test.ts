import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../../../src/providers/anthropic.js';
import { tuff } from '../../../src/tuff.js';
import { BudgetExceededError } from '../../../src/budget.js';
import { ANTHROPIC_API_KEY, createTempStateDir, cleanupDir, assertValidProviderResult } from '../helpers.js';

const test = ANTHROPIC_API_KEY ? it : it.skip;

const MODEL = 'claude-haiku-4-5-20251001';

describe('Anthropic provider', () => {
  const provider = createAnthropicProvider();

  test('executes prompt', { timeout: 30_000 }, async () => {
    const result = await provider.execute('Say exactly: hello', { model: MODEL });
    assertValidProviderResult(result);
  });

  test('respects maxTokens', { timeout: 30_000 }, async () => {
    const result = await provider.execute('Write a very long story about dragons.', { model: MODEL, maxTokens: 10 });
    assert.ok(typeof result.output === 'string', 'output must be a string');
    // 10 output tokens produces at most ~40-50 characters
    assert.ok(result.output.length <= 50, `output should be short but was ${result.output.length} chars`);
  });

  test('AbortSignal cancels request', { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider.execute('Say exactly: hello', { model: MODEL, signal: controller.signal }));
  });

  test('cancels steps when global token budget is exceeded', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('budget-anthropic');
    let thrownError: Error | null = null;
    try {
      // Direct API calls use ~8-15 tokens each (no system prompt overhead).
      // Budget of 5 ensures the first call always exceeds it.
      await tuff(
        'budget-anthropic',
        { stateDir, concurrency: 1, budget: { tokens: 5 } },
        async (ctx) => {
          await ctx.model.anthropic('job1', MODEL, 'Say: one');
          await ctx.model.anthropic('job2', MODEL, 'Say: two');
          await ctx.model.anthropic('job3', MODEL, 'Say: three');
        }
      );
    } catch (e) {
      thrownError = e as Error;
    } finally {
      cleanupDir(stateDir);
    }
    assert.ok(thrownError instanceof BudgetExceededError, 'should throw BudgetExceededError when budget exceeded');
  });
});
