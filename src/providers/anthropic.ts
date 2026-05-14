import { anthropic } from '@ai-sdk/anthropic';
import { createVercelAIProvider, type Provider } from './base.js';

export function createAnthropicProvider(): Provider {
  return createVercelAIProvider(anthropic, { extractCacheTokens: true });
}
