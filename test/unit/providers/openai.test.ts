import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../../../src/providers/openai.js';

describe('OpenAI Provider', () => {
  it('creates provider with execute function', () => {
    const provider = createOpenAIProvider();
    assert.ok(provider);
    assert.ok(typeof provider.execute === 'function');
  });
});
