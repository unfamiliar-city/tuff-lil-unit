import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider } from '../../../src/providers/openai.js';
import { OPENAI_API_KEY } from '../helpers.js';

const test = OPENAI_API_KEY ? it : it.skip;

describe('OpenAI Responses API — web search traces', () => {
  const provider = createOpenAIProvider();

  test('raw.webSearchResults contains web_search action traces', { timeout: 60_000 }, async () => {
    const result = await provider.execute(
      'What is the current date? Use web search.',
      {
        model: 'gpt-5-mini',
        tools: [{ type: 'web_search_preview' }],
      },
    );

    assert.ok(typeof result.output === 'string' && result.output.length > 0, 'output must be non-empty');
    assert.ok(Array.isArray(result.raw.webSearchResults), 'raw.webSearchResults must be an array');
    assert.ok(result.raw.webSearchResults.length > 0, 'expected at least one web search result');

    for (const entry of result.raw.webSearchResults) {
      assert.ok(entry.action?.type, `result missing action.type: ${JSON.stringify(entry)}`);
      assert.ok(
        ['search', 'open_page', 'find_in_page'].includes(entry.action.type),
        `unexpected action type: ${entry.action.type}`,
      );
    }

    // A current-date query should trigger a search action with accessible query strings
    const searchActions = result.raw.webSearchResults.filter((r) => r.action.type === 'search');
    assert.ok(searchActions.length > 0, 'expected at least one search action');
    for (const r of searchActions) {
      assert.ok(
        r.action.type === 'search' && (r.action.queries?.length ?? 0) > 0,
        `search action missing queries: ${JSON.stringify(r.action)}`,
      );
    }
  });
});
