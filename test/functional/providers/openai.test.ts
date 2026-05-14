import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../../../src/providers/openai.js';
import { tuff } from '../../../src/tuff.js';
import { BudgetExceededError } from '../../../src/budget.js';
import { OPENAI_API_KEY, createTempStateDir, cleanupDir, assertValidProviderResult } from '../helpers.js';

const test = OPENAI_API_KEY ? it : it.skip;

const MODEL = 'gpt-5-nano';

describe('OpenAI provider', () => {
  const provider = createOpenAIProvider();

  test('executes prompt', { timeout: 30_000 }, async () => {
    const result = await provider.execute('Say exactly: hello', { model: MODEL });
    assertValidProviderResult(result);
  });

  test('respects maxTokens', { timeout: 30_000 }, async () => {
    const result = await provider.execute('Write a very long story about dragons.', { model: MODEL, maxTokens: 16 });
    assert.ok(typeof result.output === 'string', 'output must be a string');
    // 16 output tokens produces at most ~80 characters
    assert.ok(result.output.length <= 80, `output should be short but was ${result.output.length} chars`);
  });

  test('AbortSignal cancels request', { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => provider.execute('Say exactly: hello', { model: MODEL, signal: controller.signal }));
  });

  test('cancels steps when global token budget is exceeded', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('budget-openai');
    let thrownError: Error | null = null;
    try {
      await tuff(
        'budget-openai',
        { stateDir, concurrency: 1, budget: { tokens: 100 } },
        async (ctx) => {
          await ctx.step('job1', () => ctx.model.openai(MODEL, 'Say: one'));
          await ctx.step('job2', () => ctx.model.openai(MODEL, 'Say: two'));
          await ctx.step('job3', () => ctx.model.openai(MODEL, 'Say: three'));
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
