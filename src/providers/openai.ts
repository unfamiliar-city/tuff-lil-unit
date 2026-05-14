import { openai } from '@ai-sdk/openai';
import { createVercelAIProvider, type Provider } from './base.js';

export function createOpenAIProvider(): Provider {
  return createVercelAIProvider(openai);
}
