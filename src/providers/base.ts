import { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ProviderResult } from '../types.js';
import type { StepBudget } from '../types.js';

export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export interface ModelOpts extends StepBudget {
  system?: string;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  schema?: ZodType | Record<string, unknown>;
  tools?: unknown;
}

export interface Provider<R = unknown> {
  execute(
    prompt: string,
    options: { model: string; signal?: AbortSignal } & ModelOpts
  ): Promise<ProviderResult<unknown, R>>;
}

export function toJSONSchema(schema: ZodType | Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return schema instanceof ZodType ? zodToJsonSchema(schema as any) as Record<string, unknown> : schema;
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
