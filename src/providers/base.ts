import { generateText, generateObject, type LanguageModel } from 'ai';
import type { ProviderResult, TokenUsage } from '../types.js';

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export interface Provider {
  execute(
    prompt: string,
    options: { model: string; maxTokens?: number; signal?: AbortSignal } & Record<string, unknown>
  ): Promise<ProviderResult>;
}

export function extractRetryAfter(headers?: Record<string, string>): number | undefined {
  if (!headers) return undefined;

  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (!retryAfter) return undefined;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return undefined;
}

export function createVercelAIProvider(
  createModel: (id: string) => LanguageModel,
  options?: { extractCacheTokens?: boolean },
): Provider {
  return {
    async execute(prompt, executeOptions) {
      const startTime = Date.now();
      const { model: modelId, maxTokens, signal, schema, ...rest } = executeOptions;

      try {
        let output: unknown;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let rawUsage: { inputTokens?: number; outputTokens?: number; [key: string]: any };

        if (schema) {
          const result = await generateObject({
            model: createModel(modelId),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            schema: schema as any,
            prompt,
            maxOutputTokens: maxTokens,
            abortSignal: signal,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(rest as any),
          });
          output = result.object;
          rawUsage = result.usage;
        } else {
          const result = await generateText({
            model: createModel(modelId),
            prompt,
            maxOutputTokens: maxTokens,
            abortSignal: signal,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(rest as any),
          });
          output = result.text;
          rawUsage = result.usage;
        }

        const usage: TokenUsage = {
          inputTokens: rawUsage.inputTokens ?? 0,
          outputTokens: rawUsage.outputTokens ?? 0,
          ...(options?.extractCacheTokens && {
            cacheCreationTokens: rawUsage.inputTokenDetails?.cacheWriteTokens,
            cacheReadTokens: rawUsage.inputTokenDetails?.cacheReadTokens,
          }),
        };

        return { output, usage, durationMs: Date.now() - startTime };
      } catch (error: unknown) {
        const errorObj = error as {
          status?: number;
          statusCode?: number;
          headers?: Record<string, string>;
          response?: { headers?: Record<string, string> };
          message?: string;
        };

        if (errorObj.status === 429 || errorObj.statusCode === 429) {
          const headers = errorObj.headers || errorObj.response?.headers;
          const retryAfter = extractRetryAfter(headers);
          throw new RateLimitError(errorObj.message || 'Rate limit exceeded', retryAfter);
        }

        throw error;
      }
    },
  };
}
