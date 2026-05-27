import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRetryAfter,
  RateLimitError,
} from '../../../src/providers/base.js';
import { BudgetExceededError } from '../../../src/budget.js';

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
