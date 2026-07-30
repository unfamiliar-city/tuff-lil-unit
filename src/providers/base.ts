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

/**
 * OpenAI Responses API effort ladder. Vendor-specific despite sitting on the shared
 * ModelOpts surface — the anthropic and claude-cli providers never read `reasoning`,
 * so a value set here is silently ignored by them. Anthropic's equivalent is a
 * different shape entirely (`thinking: { budget_tokens }`); when that needs support,
 * `reasoning` should move to per-provider option types rather than growing a union
 * that means different things depending on who reads it.
 *
 * Mirrors `ReasoningEffort` in the pinned openai SDK (6.38.0), minus its `null`. The API
 * docs also list `max`, which the SDK's type does not accept — adding it needs an SDK
 * bump, not just an entry here.
 */
export type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface ModelOpts extends StepBudget {
  system?: string;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  schema?: ZodType | Record<string, unknown>;
  tools?: unknown;
  reasoning?: { effort: OpenAIReasoningEffort };
}

export interface Provider<R = unknown> {
  execute(
    prompt: string,
    options: { model: string; signal?: AbortSignal } & ModelOpts
  ): Promise<ProviderResult<unknown, R>>;
}

function isZodSchema(schema: unknown): boolean {
  // Duck-type check to avoid cross-module instanceof failures when caller's Zod
  // instance differs from tuff's (e.g. different node_modules trees)
  return (
    typeof schema === 'object' &&
    schema !== null &&
    '_def' in schema &&
    'parse' in schema &&
    typeof (schema as Record<string, unknown>).parse === 'function'
  );
}

export function toJSONSchema(schema: ZodType | Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return isZodSchema(schema) ? zodToJsonSchema(schema as any) as Record<string, unknown> : schema as Record<string, unknown>;
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
