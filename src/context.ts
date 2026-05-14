import type Database from 'better-sqlite3';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { BudgetManager } from './budget.js';
import { BudgetExceededError } from './budget.js';
import type { Provider } from './providers/base.js';
import { ClaudeCLIProvider } from './providers/claude-cli.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createRetryConfig } from './retry.js';
import { StateManager } from './state.js';
import type { Progress, TokenUsage, StepBudget } from './types.js';
import { upsertRow } from './upsert.js';

/** Default token estimator: ~4 chars per token, conservative (overestimates = safer for budgets). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Strip StepBudget-only fields so they don't leak into provider execute() calls. */
function stripBudgetOpts(
  opts?: StepBudget & Record<string, unknown>,
): Record<string, unknown> {
  if (!opts) return {};
  const { maxInputTokens: _, onExceed: __, tokenEstimator: ___, ...rest } = opts;
  return rest;
}

export class AbortError extends Error {
  constructor(message = 'Operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export interface StageOptions {
  concurrency?: number;
  /** Invalidate cached results for all steps in this stage. Use when code changes affect output shape. */
  force?: boolean;
}

export interface StepOptions {
  /** Invalidate cached result for this step. Use when code changes affect output shape. */
  force?: boolean;
}

export interface ContextConfig {
  id: string;
  concurrency: number;
  onProgress?: (progress: Progress) => void;
  signal: AbortSignal;
  state: StateManager;
  budgetManager: BudgetManager;
  db: Database.Database;
  providers?: {
    anthropic?: Provider;
    openai?: Provider;
    claudeCode?: Provider;
  };
}

export class Context {
  #limiter: ReturnType<typeof pLimit>;
  #defaultConcurrency: number;
  #state: StateManager;
  #budget: BudgetManager;
  #signal: AbortSignal;
  #onProgress?: (progress: Progress) => void;

  #stage: string = '';
  #forceStage: boolean = false;
  #registered: number = 0;
  #completed: number = 0;

  // Per-step usage side-channel: provider helpers write here, step() reads for persistence.
  // Concurrency-safe because step IDs are unique.
  #stepUsage = new Map<string, TokenUsage>();

  // Lazy provider instances — constructed on first use, shared across all calls
  #claudeCode?: Provider;
  #anthropic?: Provider;
  #openai?: Provider;

  readonly db: Database.Database;

  constructor(config: ContextConfig) {
    this.#defaultConcurrency = config.concurrency;
    this.#limiter = pLimit(config.concurrency);
    this.#state = config.state;
    this.#budget = config.budgetManager;
    this.#signal = config.signal;
    this.#onProgress = config.onProgress;
    this.db = config.db;

    this.#anthropic = config.providers?.anthropic;
    this.#openai = config.providers?.openai;
    this.#claudeCode = config.providers?.claudeCode;

    // Seed completed count from prior run for progress prediction on resume
    this.#completed = config.state.getStepCount();
  }

  /** Set the current stage label, reset per-stage counters, optionally override concurrency. */
  stage(label: string, options?: StageOptions): void {
    this.#stage = label;
    this.#forceStage = options?.force ?? false;
    this.#registered = 0;
    this.#completed = 0;
    this.#limiter = pLimit(options?.concurrency ?? this.#defaultConcurrency);
    this.#fireProgress();
  }

  #fireProgress(): void {
    this.#onProgress?.({
      stage: this.#stage,
      completed: this.#completed,
      total: this.#registered,
      usage: { tokens: this.#budget.totalUsed() },
    });
  }

  #checkInputBudget(prompt: string, opts?: StepBudget): void {
    if (!opts?.maxInputTokens) return;
    const estimate = (opts.tokenEstimator ?? estimateTokens)(prompt);
    if (estimate > opts.maxInputTokens) {
      throw new BudgetExceededError(
        `Estimated input tokens (${estimate}) exceeds step limit (${opts.maxInputTokens})`,
      );
    }
  }

  #checkPostCallUsage(id: string, usage: TokenUsage, opts?: StepBudget): void {
    if (!opts) return;
    const exceeded =
      (opts.maxInputTokens && usage.inputTokens > opts.maxInputTokens) ||
      (opts.maxTokens && usage.outputTokens > opts.maxTokens);
    if (!exceeded) return;

    const msg = `Step '${id}' exceeded budget: ${usage.inputTokens} input, ${usage.outputTokens} output`;
    if (opts.onExceed === 'warn') {
      console.warn(`[tuff] ${msg}`);
      return;
    }
    throw new BudgetExceededError(msg);
  }

  /**
   * Durable step: checks SQLite cache, enforces budget/abort, then executes with
   * concurrency limiting and retry. Result is persisted on success; failure is
   * recorded in step_failures for crash forensics and resume control.
   *
   * Note: step functions must return JSON-serializable values. Date, Buffer, and
   * class instances silently corrupt on round-trip.
   */
  async step<T>(id: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
    const force = options?.force || this.#forceStage;
    if (force) {
      this.#state.deleteStep(id);
    } else {
      const cached = this.#state.getStep(id);
      if (cached !== undefined) return cached as T;
    }

    // Abort check before entering the limiter queue
    if (this.#signal.aborted) throw new AbortError();
    if (this.#budget.isExceeded()) throw new BudgetExceededError('Budget exceeded');

    // Register synchronously before the limiter queue — enables fan-out total tracking
    // (Promise.all registers all steps before any executes)
    this.#registered++;

    return this.#limiter(async () => {
      // Check again after waiting in the queue — signal may have fired while queued
      if (this.#signal.aborted) throw new AbortError();

      const startTime = Date.now();
      try {
        // Check signal at the start of each retry attempt rather than passing it to
        // pRetry directly — pRetry would race the signal against fn(), which breaks
        // the case where fn() itself triggers the abort (e.g., budget kill).
        const result = await pRetry(() => {
          if (this.#signal.aborted) throw new AbortError();
          return fn();
        }, createRetryConfig());

        const durationMs = Date.now() - startTime;
        const usage = this.#stepUsage.get(id);
        this.#stepUsage.delete(id);
        this.#state.setStep(id, result, usage, durationMs);
        this.#completed++;
        this.#fireProgress();
        return result;
      } catch (error) {
        // Only abort if the pipeline's own signal fired — not per-request AbortErrors
        // (e.g., Vercel AI SDK throws AbortError on per-call timeouts)
        if (this.#signal.aborted) {
          throw new AbortError();
        }
        this.#stepUsage.delete(id);
        const durationMs = Date.now() - startTime;
        this.#state.setStepFailure(id, String(error), durationMs);
        throw error;
      }
    });
  }

  /**
   * Batch step+upsert: run each item through step() for memoization/retry/concurrency,
   * then upsert results into a DB table. Returns count of rows written.
   */
  async upsert<TItem, TResult>(
    items: TItem[],
    options: {
      table: string;
      key: (item: TItem) => string;
      run: (item: TItem) => Promise<TResult>;
      skip?: (result: TResult) => boolean;
      map?: (result: TResult) => Record<string, unknown>;
      update?: string[];
    },
  ): Promise<number> {
    let written = 0;
    const results = await Promise.all(
      items.map(async (item) => {
        const result = await this.step(options.key(item), () => options.run(item));
        return { result, item };
      }),
    );
    for (const { result } of results) {
      if (options.skip?.(result)) continue;
      const row = options.map ? options.map(result) : result as Record<string, unknown>;
      upsertRow(this.db, options.table, row, options.update);
      written++;
    }
    return written;
  }

  // Agent providers (subprocess-based coding agents — model chosen per-call)
  readonly agent = {
    /**
     * Execute a step via the Claude Code CLI (experimental).
     * Spawns a headless `claude -p` subprocess using your local CLI subscription.
     * Budget is enforced by monitoring the live transcript mid-execution.
     * API may change in future releases.
     * @experimental
     */
    claudeCode: (id: string, model: string, prompt: string, opts?: StepBudget): Promise<unknown> => {
      this.#claudeCode ??= new ClaudeCLIProvider();
      return this.step(id, async () => {
        this.#checkInputBudget(prompt, opts);
        const result = await this.#claudeCode!.execute(prompt, {
          model,
          maxTokens: opts?.maxTokens,
          signal: this.#signal,
        });
        this.#budget.consume(result.usage);
        this.#stepUsage.set(id, result.usage);
        this.#checkPostCallUsage(id, result.usage, opts);
        return result.output;
      });
    },
  };

  // Model providers (direct HTTP API calls — model required per-call)
  readonly model = {
    anthropic: <T>(
      id: string,
      model: string,
      prompt: string,
      opts?: StepBudget & Record<string, unknown>,
    ): Promise<T> => {
      this.#anthropic ??= createAnthropicProvider();
      return this.step(id, async () => {
        this.#checkInputBudget(prompt, opts);
        const result = await this.#anthropic!.execute(prompt, {
          model,
          signal: this.#signal,
          ...stripBudgetOpts(opts),
        });
        this.#budget.consume(result.usage);
        this.#stepUsage.set(id, result.usage);
        this.#checkPostCallUsage(id, result.usage, opts);
        return result.output as T;
      });
    },

    openai: <T>(
      id: string,
      model: string,
      prompt: string,
      opts?: StepBudget & Record<string, unknown>,
    ): Promise<T> => {
      this.#openai ??= createOpenAIProvider();
      return this.step(id, async () => {
        this.#checkInputBudget(prompt, opts);
        const result = await this.#openai!.execute(prompt, {
          model,
          signal: this.#signal,
          ...stripBudgetOpts(opts),
        });
        this.#budget.consume(result.usage);
        this.#stepUsage.set(id, result.usage);
        this.#checkPostCallUsage(id, result.usage, opts);
        return result.output as T;
      });
    },
  };
}
