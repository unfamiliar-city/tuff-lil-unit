import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetManager } from '../../src/budget.js';
import type { TokenUsage } from '../../src/types.js';

test('BudgetManager: consume calculates tokens correctly', () => {
  const budget = new BudgetManager({ tokens: 1000 });

  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 200,
    cacheCreationTokens: 50,
    cacheReadTokens: 1000, // Should NOT be counted
  };

  budget.consume(usage);

  assert.equal(budget.totalUsed(), 350, 'Should count input + output + cache_creation');
  assert.equal(budget.remaining(), 650, 'Should calculate remaining correctly');
});

test('BudgetManager: consume ignores cache_read tokens', () => {
  const budget = new BudgetManager({ tokens: 1000 });

  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 100,
    cacheReadTokens: 5000, // Should be ignored
  };

  budget.consume(usage);

  assert.equal(budget.totalUsed(), 200, 'Should not count cache_read');
});

test('BudgetManager: canAfford pre-flight check', () => {
  const budget = new BudgetManager({ tokens: 1000 });

  budget.consume({ inputTokens: 800, outputTokens: 0 });

  assert.equal(budget.canAfford(150), true, 'Should afford 150 tokens');
  assert.equal(budget.canAfford(300), false, 'Should not afford 300 tokens');
});

test('BudgetManager: isExceeded detects budget overrun', () => {
  const budget = new BudgetManager({ tokens: 1000 });

  assert.equal(budget.isExceeded(), false, 'Not exceeded initially');

  budget.consume({ inputTokens: 500, outputTokens: 500 });
  assert.equal(budget.isExceeded(), false, 'Not exceeded at limit');

  budget.consume({ inputTokens: 1, outputTokens: 0 });
  assert.equal(budget.isExceeded(), true, 'Exceeded after going over');
});

test('BudgetManager: unlimited budget (no globalBudget)', () => {
  const budget = new BudgetManager();

  budget.consume({ inputTokens: 10000, outputTokens: 10000 });

  assert.equal(budget.canAfford(999999), true, 'Should always afford with no budget');
  assert.equal(budget.isExceeded(), false, 'Should never be exceeded with no budget');
  assert.equal(budget.remaining(), Infinity, 'Should have infinite remaining');
  assert.equal(budget.totalUsed(), 20000, 'Should still track usage');
});

test('BudgetManager: remaining never goes negative', () => {
  const budget = new BudgetManager({ tokens: 100 });

  budget.consume({ inputTokens: 200, outputTokens: 0 });

  assert.equal(budget.remaining(), 0, 'Remaining should be 0, not negative');
  assert.equal(budget.isExceeded(), true, 'Budget should be exceeded');
});

test('BudgetManager: handles missing cache fields', () => {
  const budget = new BudgetManager({ tokens: 1000 });

  const usage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 200,
  };

  budget.consume(usage);

  assert.equal(budget.totalUsed(), 300, 'Should handle missing cache fields');
});
