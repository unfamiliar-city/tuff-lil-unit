import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { MockLanguageModelV3 } from 'ai/test';
import {
  extractRetryAfter,
  createVercelAIProvider,
  RateLimitError,
} from '../../../src/providers/base.js';
import { BudgetExceededError } from '../../../src/budget.js';

function mockTextModel(usage = { inputTokens: { total: 10 }, outputTokens: { total: 20 } }) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'hello world' }],
      rawCall: { rawPrompt: '', rawSettings: {} },
      usage,
      finishReason: 'stop' as const,
      response: { id: 'test', modelId: 'test' },
    }),
  });
}

function mockObjectModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: '{"name":"test"}' }],
      rawCall: { rawPrompt: '', rawSettings: {} },
      usage: { inputTokens: { total: 15 }, outputTokens: { total: 25 } },
      finishReason: 'stop' as const,
      response: { id: 'test', modelId: 'test' },
      warnings: [],
    }),
  });
}

describe('createVercelAIProvider', () => {
  it('text path — no schema returns result.text with usage', async () => {
    const mock = mockTextModel();
    const provider = createVercelAIProvider(() => mock);

    const result = await provider.execute('test prompt', { model: 'test-model' });

    assert.equal(result.output, 'hello world');
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 20);
    assert.ok(result.durationMs >= 0);
  });

  it('object path — schema present returns result.object', async () => {
    const mock = mockObjectModel();
    const provider = createVercelAIProvider(() => mock);

    const result = await provider.execute('test prompt', {
      model: 'test-model',
      schema: z.object({ name: z.string() }),
    });

    assert.deepEqual(result.output, { name: 'test' });
    assert.equal(result.usage.inputTokens, 15);
    assert.equal(result.usage.outputTokens, 25);
  });

  it('extractCacheTokens — includes cache fields when enabled', async () => {
    const mock = mockTextModel({
      inputTokens: { total: 100, cacheRead: 30, cacheWrite: 10 },
      outputTokens: { total: 50 },
    });
    const provider = createVercelAIProvider(() => mock, { extractCacheTokens: true });

    const result = await provider.execute('test', { model: 'test-model' });

    assert.equal(result.usage.cacheCreationTokens, 10);
    assert.equal(result.usage.cacheReadTokens, 30);
  });

  it('extractCacheTokens — omits cache fields when disabled', async () => {
    const mock = mockTextModel({
      inputTokens: { total: 100, cacheRead: 30, cacheWrite: 10 },
      outputTokens: { total: 50 },
    });
    const provider = createVercelAIProvider(() => mock);

    const result = await provider.execute('test', { model: 'test-model' });

    assert.equal(result.usage.cacheCreationTokens, undefined);
    assert.equal(result.usage.cacheReadTokens, undefined);
  });

  it('429 error wraps as RateLimitError with retryAfterMs', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => {
        const err = new Error('rate limited') as Error & {
          status: number;
          headers: Record<string, string>;
        };
        err.status = 429;
        err.headers = { 'retry-after': '30' };
        throw err;
      },
    });
    const provider = createVercelAIProvider(() => mock);

    await assert.rejects(
      () => provider.execute('test', { model: 'test-model' }),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.retryAfterMs, 30000);
        return true;
      },
    );
  });

  it('non-429 error passes through unchanged', async () => {
    const mock = new MockLanguageModelV3({
      doGenerate: async () => {
        const err = new Error('server error') as Error & { status: number };
        err.status = 500;
        throw err;
      },
    });
    const provider = createVercelAIProvider(() => mock);

    await assert.rejects(
      () => provider.execute('test', { model: 'test-model' }),
      (err: unknown) => {
        assert.ok(!(err instanceof RateLimitError));
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'server error');
        return true;
      },
    );
  });
});

describe('extractRetryAfter', () => {
  it('parses seconds string', () => {
    assert.equal(extractRetryAfter({ 'retry-after': '30' }), 30000);
  });

  it('parses date string', () => {
    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const result = extractRetryAfter({ 'retry-after': futureDate });
    assert.ok(result !== undefined);
    assert.ok(result > 0 && result <= 11000);
  });

  it('returns undefined for missing header', () => {
    assert.equal(extractRetryAfter({ 'content-type': 'application/json' }), undefined);
  });

  it('returns undefined for undefined headers', () => {
    assert.equal(extractRetryAfter(undefined), undefined);
  });

  it('handles capital-case Retry-After header', () => {
    assert.equal(extractRetryAfter({ 'Retry-After': '5' }), 5000);
  });
});

describe('Error classes', () => {
  it('RateLimitError has correct name and message', () => {
    const error = new RateLimitError('Too many requests', 5000);
    assert.equal(error.message, 'Too many requests');
    assert.equal(error.name, 'RateLimitError');
    assert.equal(error.retryAfterMs, 5000);
    assert.ok(error instanceof Error);
  });

  it('RateLimitError works without retryAfterMs', () => {
    const error = new RateLimitError('Rate limited');
    assert.equal(error.retryAfterMs, undefined);
  });

  it('BudgetExceededError has correct name and message', () => {
    const error = new BudgetExceededError('Budget blown');
    assert.equal(error.message, 'Budget blown');
    assert.equal(error.name, 'BudgetExceededError');
    assert.ok(error instanceof Error);
  });
});
