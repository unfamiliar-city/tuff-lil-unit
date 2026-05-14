import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../../../src/providers/anthropic.js';

describe('Anthropic Provider', () => {
  it('creates provider with execute function', () => {
    const provider = createAnthropicProvider();
    assert.ok(provider);
    assert.ok(typeof provider.execute === 'function');
  });
});
