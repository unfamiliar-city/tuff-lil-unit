import Anthropic from '@anthropic-ai/sdk';
import type { ProviderResult, TokenUsage } from '../types.js';
import { RateLimitError, extractRetryAfter, toJSONSchema, type Provider } from './base.js';

export interface AnthropicRaw {
  readonly stopReason: string | null;
  readonly model: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationTokens?: number;
    readonly cacheReadTokens?: number;
  };
}

export function createAnthropicProvider(): Provider<AnthropicRaw> {
  // Lazy so budget/abort checks run before credential validation
  let client: Anthropic | undefined;
  const getClient = () => (client ??= new Anthropic());

  return {
    async execute(prompt, options) {
      const { model, signal, maxTokens, system, temperature, topP, stopSequences, schema, tools } = options;
      const startTime = Date.now();

      try {
        const response = await getClient().messages.create(
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens ?? 4096,
            ...(system ? { system } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(topP !== undefined ? { top_p: topP } : {}),
            ...(stopSequences ? { stop_sequences: stopSequences } : {}),
            ...(tools ? { tools: tools as Anthropic.Tool[] } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(schema ? { output_config: { format: { type: 'json_schema', schema: toJSONSchema(schema) } } } as any : {}),
          },
          { signal },
        );

        const textBlock = response.content.find((b) => b.type === 'text');
        const rawText = textBlock?.type === 'text' ? textBlock.text : '';
        const output: unknown = schema ? JSON.parse(rawText) : rawText;

        const usage: TokenUsage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? undefined,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
        };

        const raw: AnthropicRaw = {
          stopReason: response.stop_reason,
          model: response.model,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            cacheCreationTokens: response.usage.cache_creation_input_tokens ?? undefined,
            cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
          },
        };

        return { output, usage, durationMs: Date.now() - startTime, raw } as ProviderResult<unknown, AnthropicRaw>;
      } catch (error: unknown) {
        if (error instanceof Anthropic.APIError && error.status === 429) {
          const retryAfter = extractRetryAfter(error.headers as Record<string, string>);
          throw new RateLimitError(error.message, retryAfter);
        }
        throw error;
      }
    },
  };
}
