import type { Options as PRetryOptions, RetryContext } from 'p-retry';

export interface ErrorClassification {
  type: 'rate_limit' | 'transient' | 'token_limit' | 'budget_exceeded' | 'permanent';
  retriable: boolean;
  retryAfterMs?: number;
}

export function classifyError(error: unknown): ErrorClassification {
  if (!error) {
    return { type: 'permanent', retriable: false };
  }

  // Check for enhanced error types with retryAfterMs
  if (error instanceof Error && 'retryAfterMs' in error) {
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
    return {
      type: 'rate_limit',
      retriable: true,
      retryAfterMs,
    };
  }

  const errorObj = error as Record<string, unknown>;
  const message = String(errorObj.message || error).toLowerCase();

  if (errorObj.status === 429 || message.includes('rate limit')) {
    return { type: 'rate_limit', retriable: true };
  }

  if (
    message.includes('token limit') ||
    message.includes('context limit') ||
    message.includes('maximum context') ||
    message.includes('too many tokens')
  ) {
    return { type: 'token_limit', retriable: false };
  }

  if (message.includes('budget exceeded')) {
    return { type: 'budget_exceeded', retriable: false };
  }

  // AbortError from per-request timeouts (AbortController pattern) — retriable
  // Note: pipeline-level aborts are handled separately in context.ts (signal check)
  if (errorObj.name === 'AbortError' || message.includes('timed out')) {
    return { type: 'transient', retriable: true };
  }

  if (
    typeof errorObj.status === 'number' &&
    errorObj.status >= 500 &&
    errorObj.status < 600
  ) {
    return { type: 'transient', retriable: true };
  }

  return { type: 'permanent', retriable: false };
}

/** Returns p-retry options using classifyError to decide retriability and respect Retry-After. */
export function createRetryConfig(opts?: { maxRetries?: number }): PRetryOptions {
  return {
    retries: opts?.maxRetries ?? 3,
    factor: 2,
    minTimeout: 1000,
    maxTimeout: 60_000,
    shouldRetry: (context: RetryContext) => {
      const classification = classifyError(context.error);
      return classification.retriable;
    },
    onFailedAttempt: async (context: RetryContext) => {
      const classification = classifyError(context.error);
      if (classification.retriable && classification.retryAfterMs && context.retriesLeft > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, classification.retryAfterMs)
        );
      }
    },
  };
}
