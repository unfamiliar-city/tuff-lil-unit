import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { ClaudeCLIProvider } from '../../../src/providers/claude-cli.js';
import { tuff } from '../../../src/tuff.js';
import { BudgetExceededError } from '../../../src/budget.js';
import { HAS_CLAUDE_CLI, createTempStateDir, cleanupDir, assertValidProviderResult } from '../helpers.js';

const test = HAS_CLAUDE_CLI ? it : it.skip;

const MODEL = 'claude-haiku-4-5-20251001';

describe('ClaudeCLIProvider', () => {
  const provider = new ClaudeCLIProvider();
  const PROMPT = 'Say exactly: hello';

  test('executes prompt and returns non-empty output', { timeout: 30_000 }, async () => {
    const result = await provider.execute(PROMPT, { model: MODEL });
    assertValidProviderResult(result);
    assert.ok(typeof result.output === 'string' && result.output.length > 0, 'output contains text');
  });

  test('returns token usage with inputTokens > 0', { timeout: 30_000 }, async () => {
    const result = await provider.execute(PROMPT, { model: MODEL });
    assert.ok(result.usage.inputTokens > 0, 'inputTokens must be > 0');
    assert.ok(result.usage.outputTokens > 0, 'outputTokens must be > 0');
  });

  test('AbortSignal cancels in-flight request', { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    const promise = provider.execute(
      'Write a 10000 word essay about the complete history of computing from 1940 to present.',
      { model: MODEL, signal: controller.signal },
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    controller.abort();

    await assert.rejects(promise);
  });

  test('web search tool can be invoked', { timeout: 30_000 }, async () => {
    const result = await provider.execute("What is today's date? Use web search to find the current date.", { model: MODEL });
    assert.ok(typeof result.output === 'string' && result.output.length > 0, 'output must be non-empty');
  });

  test('cancels steps when global token budget is exceeded', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('budget-cli');
    let thrownError: Error | null = null;
    try {
      // Any real claude -p call uses 200+ input tokens from the system prompt alone.
      // A budget of 100 will be exceeded after job1 completes, cancelling the rest.
      await tuff(
        'budget-cli',
        { stateDir, concurrency: 1, budget: { tokens: 100 } },
        async (ctx) => {
          await ctx.step('job1', () => ctx.agent.claudeCode(MODEL, 'Say: one'));
          await ctx.step('job2', () => ctx.agent.claudeCode(MODEL, 'Say: two'));
          await ctx.step('job3', () => ctx.agent.claudeCode(MODEL, 'Say: three'));
        }
      );
    } catch (e) {
      thrownError = e as Error;
    } finally {
      cleanupDir(stateDir);
    }
    assert.ok(thrownError instanceof BudgetExceededError, 'should throw BudgetExceededError when budget exceeded');
  });

  test('step-level maxTokens — throws BudgetExceededError when output exceeds limit', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('step-budget-cli');
    try {
      // maxTokens is a post-call output token limit, same as the API providers.
      // A long-essay prompt will produce far more than 50 output tokens.
      await assert.rejects(
        () => tuff(
          'step-budget',
          { stateDir, concurrency: 1 },
          async (ctx) => {
            await ctx.step('capped', () =>
              ctx.agent.claudeCode(MODEL, 'Write a long essay about the history of computing.', { maxTokens: 50 }),
            );
          },
        ),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.strictEqual(err.constructor.name, 'BudgetExceededError');
          return true;
        },
      );
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('token accumulation across 10 steps — budget 2000 completes some but not all', { timeout: 120_000 }, async () => {
    const stateDir = createTempStateDir('accum-cli');
    let completedSteps = 0;
    let thrownError: Error | null = null;
    try {
      await tuff(
        'accum-cli',
        { stateDir, concurrency: 1, budget: { tokens: 2000 } },
        async (ctx) => {
          for (let i = 0; i < 10; i++) {
            await ctx.step(`step-${i}`, () => ctx.agent.claudeCode(MODEL, `Say exactly: ${i}`));
            completedSteps++;
          }
        },
      );
    } catch (e) {
      thrownError = e as Error;
    } finally {
      cleanupDir(stateDir);
    }
    assert.ok(thrownError instanceof BudgetExceededError, 'should throw BudgetExceededError');
    assert.ok(completedSteps > 0, `should complete at least 1 step (got ${completedSteps})`);
    assert.ok(completedSteps < 10, `should NOT complete all 10 steps (got ${completedSteps})`);
  });

  test('known prompt returns token counts in plausible range', { timeout: 30_000 }, async () => {
    const result = await provider.execute(PROMPT, { model: MODEL });
    // System prompt overhead means input is typically 100-2000 tokens
    assert.ok(result.usage.inputTokens >= 10, `inputTokens too low: ${result.usage.inputTokens}`);
    assert.ok(result.usage.inputTokens < 5000, `inputTokens implausibly high: ${result.usage.inputTokens}`);
    // "hello" response is a few tokens
    assert.ok(result.usage.outputTokens >= 1, `outputTokens too low: ${result.usage.outputTokens}`);
    assert.ok(result.usage.outputTokens < 500, `outputTokens implausibly high: ${result.usage.outputTokens}`);
  });

  test('no leftover /tmp/tuff-worker-* dirs after budget kill', { timeout: 60_000 }, async () => {
    const tag = `cleanup-${Date.now()}`;
    const stateDir = createTempStateDir(tag);
    try {
      await tuff(
        `cleanup-${tag}`,
        { stateDir, concurrency: 1, budget: { tokens: 100 } },
        async (ctx) => {
          await ctx.step('j1', () => ctx.agent.claudeCode(MODEL, 'Say: one'));
          await ctx.step('j2', () => ctx.agent.claudeCode(MODEL, 'Say: two'));
        },
      );
    } catch {
      // Expected BudgetExceededError
    } finally {
      cleanupDir(stateDir);
    }

    // Check that no tuff-worker-* dirs remain from this test run
    const leftover = readdirSync('/tmp').filter((f) => f.startsWith('tuff-worker-'));
    assert.equal(leftover.length, 0, `leftover worker dirs: ${leftover.join(', ')}`);
  });
});
