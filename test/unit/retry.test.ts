import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, createRetryConfig, type ErrorClassification } from '../../src/retry.js';

test('retry: classifyError detects rate_limit (429)', () => {
  const error = { status: 429, message: 'Too Many Requests' };
  const result = classifyError(error);
  assert.equal(result.type, 'rate_limit');
  assert.equal(result.retriable, true);
});

test('retry: classifyError detects rate_limit (message)', () => {
  const error = { message: 'Rate limit exceeded' };
  const result = classifyError(error);
  assert.equal(result.type, 'rate_limit');
  assert.equal(result.retriable, true);
});

test('retry: classifyError detects transient (5xx)', () => {
  assert.equal(classifyError({ status: 500 }).type, 'transient');
  assert.equal(classifyError({ status: 502 }).type, 'transient');
  assert.equal(classifyError({ status: 503 }).type, 'transient');
  assert.equal(classifyError({ status: 599 }).type, 'transient');
  assert.equal(classifyError({ status: 500 }).retriable, true);
});

test('retry: classifyError detects token_limit', () => {
  assert.equal(
    classifyError({ message: 'Token limit exceeded' }).type,
    'token_limit'
  );
  assert.equal(
    classifyError({ message: 'Context limit exceeded' }).type,
    'token_limit'
  );
  assert.equal(
    classifyError({ message: 'Maximum context length' }).type,
    'token_limit'
  );
  assert.equal(
    classifyError({ message: 'Too many tokens' }).type,
    'token_limit'
  );
  assert.equal(
    classifyError({ message: 'Token limit exceeded' }).retriable,
    false
  );
});

test('retry: classifyError detects budget_exceeded', () => {
  const error = { message: 'Budget exceeded' };
  const result = classifyError(error);
  assert.equal(result.type, 'budget_exceeded');
  assert.equal(result.retriable, false);
});

test('retry: classifyError detects rate_limit with retryAfterMs', () => {
  class RetryError extends Error {
    retryAfterMs = 5000;
    constructor() {
      super('Rate limited');
    }
  }

  const error = new RetryError();
  const result = classifyError(error);
  assert.equal(result.type, 'rate_limit');
  assert.equal(result.retriable, true);
  assert.equal(result.retryAfterMs, 5000);
});

test('retry: classifyError defaults to permanent', () => {
  assert.equal(classifyError({ status: 400 }).type, 'permanent');
  assert.equal(classifyError({ status: 404 }).type, 'permanent');
  assert.equal(classifyError({ message: 'Unknown error' }).type, 'permanent');
  assert.equal(classifyError('Generic error').type, 'permanent');
  assert.equal(classifyError(null).type, 'permanent');
  assert.equal(classifyError({ status: 400 }).retriable, false);
});

test('retry: createRetryConfig returns valid p-retry options', () => {
  const config = createRetryConfig();
  assert.ok(config);
  assert.equal(typeof config.retries, 'number');
  assert.equal(config.retries, 3);
  assert.equal(typeof config.shouldRetry, 'function');
  assert.equal(typeof config.onFailedAttempt, 'function');
});

test('retry: createRetryConfig respects maxRetries override', () => {
  const config = createRetryConfig({ maxRetries: 5 });
  assert.equal(config.retries, 5);
});

test('retry: createRetryConfig shouldRetry allows retriable errors', () => {
  const config = createRetryConfig();
  const retriable = config.shouldRetry!({
    error: new Error('Rate limit exceeded'),
    attemptNumber: 1,
    retriesLeft: 3,
    retriesConsumed: 0,
  });
  assert.equal(retriable, true);
});

test('retry: createRetryConfig shouldRetry blocks non-retriable errors', () => {
  const config = createRetryConfig();
  const retriable = config.shouldRetry!({
    error: new Error('Token limit exceeded'),
    attemptNumber: 1,
    retriesLeft: 3,
    retriesConsumed: 0,
  });
  assert.equal(retriable, false);
});

test('retry: createRetryConfig shouldRetry blocks permanent errors', () => {
  const config = createRetryConfig();
  const retriable = config.shouldRetry!({
    error: new Error('Not found'),
    attemptNumber: 1,
    retriesLeft: 3,
    retriesConsumed: 0,
  });
  assert.equal(retriable, false);
});
