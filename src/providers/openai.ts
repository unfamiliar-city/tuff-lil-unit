import OpenAI from 'openai';
import type { ProviderResult, TokenUsage } from '../types.js';
import { RateLimitError, extractRetryAfter, toJSONSchema, type Provider } from './base.js';

export interface OpenAIWebSearchSource {
  readonly type: string; // 'url' for web results; 'api' for internal sources (e.g. oai-time)
  readonly url?: string;
  readonly name?: string;
}

export type OpenAIWebSearchAction =
  | { readonly type: 'search'; readonly query?: string; readonly queries?: string[]; readonly sources?: OpenAIWebSearchSource[] }
  | { readonly type: 'open_page'; readonly url?: string | null }
  | { readonly type: 'find_in_page'; readonly url: string; readonly pattern: string };

export interface OpenAIWebSearchResult {
  readonly id: string;
  readonly status: 'in_progress' | 'searching' | 'completed' | 'failed';
  readonly action: OpenAIWebSearchAction;
}

export interface OpenAIRaw {
  readonly text?: string;
  readonly object?: unknown;
  readonly webSearchResults: OpenAIWebSearchResult[];
  readonly outputAnnotations: unknown[];
}

export function createOpenAIProvider(): Provider<OpenAIRaw> {
  // Lazy so budget/abort checks run before credential validation
  let client: OpenAI | undefined;
  const getClient = () => (client ??= new OpenAI());

  return {
    async execute(prompt, options) {
      const { model, signal, maxTokens, system, temperature, topP, schema, tools } = options;
      const startTime = Date.now();

      try {
        const response = await getClient().responses.create({
          model,
          input: prompt,
          include: ['web_search_call.action.sources', 'web_search_call.results'] as OpenAI.Responses.ResponseIncludable[],
          ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
          ...(system ? { instructions: system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(topP !== undefined ? { top_p: topP } : {}),
          ...(tools ? { tools: tools as OpenAI.Responses.Tool[] } : {}),
          ...(schema ? {
            text: {
              format: {
                type: 'json_schema' as const,
                name: 'response',
                schema: toJSONSchema(schema),
                strict: true,
              },
            },
          } : {}),
        }, { signal });

        const output: unknown = schema ? JSON.parse(response.output_text) : response.output_text;

        const webSearchResults: OpenAIWebSearchResult[] = response.output
          .filter((item) => item.type === 'web_search_call')
          .map((item) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ws = item as any;
            return {
              id: ws.id as string,
              status: ws.status as OpenAIWebSearchResult['status'],
              action: ws.action as OpenAIWebSearchAction,
            };
          });

        const outputAnnotations: unknown[] = response.output
          .filter((item) => item.type === 'message')
          .flatMap((item) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const msg = item as any;
            return (msg.content as Array<{ annotations?: unknown[] }>)
              ?.flatMap((c) => c.annotations ?? []) ?? [];
          });

        const usage: TokenUsage = {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        };

        const raw: OpenAIRaw = {
          text: response.output_text,
          webSearchResults,
          outputAnnotations,
        };

        return { output, usage, durationMs: Date.now() - startTime, raw };
      } catch (error: unknown) {
        if (error instanceof OpenAI.APIError && error.status === 429) {
          const retryAfter = extractRetryAfter(error.headers as Record<string, string>);
          throw new RateLimitError(error.message, retryAfter);
        }
        throw error;
      }
    },
  };
}
