import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { BudgetManager } from './budget.js';
import { BudgetExceededError } from './budget.js';
import type { Provider, ModelOpts } from './providers/base.js';
import { ClaudeCLIProvider } from './providers/claude-cli.js';
import type { ClaudeCLIRaw } from './providers/claude-cli.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import type { AnthropicRaw } from './providers/anthropic.js';
import { createOpenAIProvider } from './providers/openai.js';
import type { OpenAIRaw } from './providers/openai.js';
import { createRetryConfig } from './retry.js';
import { StateManager } from './state.js';
import type { Progress, ProviderResult, TokenUsage, StepBudget } from './types.js';
import { upsertRow } from './upsert.js';

/** Default token estimator: ~4 chars per token, conservative (overestimates = safer for budgets). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  // AsyncLocalStorage propagates the enclosing step ID through async continuations,
  // so concurrent steps never clobber each other's IDs in provider usage tracking.
  #stepIdStore = new AsyncLocalStorage<string>();
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

  #checkGlobalBudget(): void {
    if (this.#budget.isExceeded()) {
      throw new BudgetExceededError('Budget exceeded');
    }
  }

  #checkPostCallUsage(usage: TokenUsage, opts?: StepBudget): void {
    if (!opts) return;
    const exceeded =
      (opts.maxInputTokens && usage.inputTokens > opts.maxInputTokens) ||
      (opts.maxTokens && usage.outputTokens > opts.maxTokens);
    if (!exceeded) return;

    const stepId = this.#stepIdStore.getStore() ?? '(untracked)';
    const msg = `Step '${stepId}' exceeded budget: ${usage.inputTokens} input, ${usage.outputTokens} output`;
    if (opts.onExceed === 'warn') {
      console.warn(`[tuff] ${msg}`);
      return;
    }
    throw new BudgetExceededError(msg);
  }

  /**
   * Bare provider calls go through the limiter so fan-out (Promise.all of provider
   * calls) respects pipeline concurrency. Inside a step, the step already holds a
   * limiter slot — re-acquiring would deadlock at concurrency=1, so skip.
   */
  #gated<T>(fn: () => Promise<T>): Promise<T> {
    return this.#stepIdStore.getStore() !== undefined ? fn() : this.#limiter(fn);
  }

  #recordUsage(usage: TokenUsage): void {
    this.#budget.consume(usage);
    const stepId = this.#stepIdStore.getStore();
    if (stepId === undefined) return;
    const prev = this.#stepUsage.get(stepId);
    if (prev) {
      this.#stepUsage.set(stepId, {
        inputTokens: prev.inputTokens + usage.inputTokens,
        outputTokens: prev.outputTokens + usage.outputTokens,
        cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
        cacheReadTokens: (prev.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      });
    } else {
      this.#stepUsage.set(stepId, usage);
    }
  }

  /**
   * Resumable step: checks SQLite cache, enforces budget/abort, then executes with
   * concurrency limiting and retry. Result is persisted on success; failure is
   * recorded in step_failures for crash forensics and resume control.
   *
   * Note: step functions must return JSON-serializable values. Date, Buffer, and
   * class instances silently corrupt on round-trip.
   */
  async step<T>(id: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
    if (this.#stepIdStore.getStore() !== undefined) {
      throw new Error(
        `ctx.step() cannot be nested inside another step or upsert.\n` +
        `Steps are the durability boundary — put execution (provider calls,\n` +
        `fetch, etc.) inside them, not other steps.`,
      );
    }

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
        // stepIdStore.run propagates the step ID through all async continuations,
        // so providers called inside fn() can associate their usage with this step.
        // Check signal at the start of each retry attempt rather than passing it to
        // pRetry directly — pRetry would race the signal against fn(), which breaks
        // the case where fn() itself triggers the abort (e.g., budget kill).
        const result = await this.#stepIdStore.run(id, () =>
          pRetry(() => {
            if (this.#signal.aborted) throw new AbortError();
            return fn();
          }, createRetryConfig()),
        );

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
     * Execute a prompt via the Claude Code CLI (experimental).
     * Spawns a headless `claude -p` subprocess using your local CLI subscription.
     * Wrap in ctx.step() for durability and crash recovery.
     * @experimental
     */
    claudeCode: async (model: string, prompt: string, opts?: StepBudget): Promise<ProviderResult<string, ClaudeCLIRaw>> => {
      this.#claudeCode ??= new ClaudeCLIProvider();
      this.#checkGlobalBudget();
      this.#checkInputBudget(prompt, opts);
      const exec = async () => {
        const result = await this.#claudeCode!.execute(prompt, {
          model,
          maxTokens: opts?.maxTokens,
          signal: this.#signal,
        });
        this.#recordUsage(result.usage);
        this.#checkPostCallUsage(result.usage, opts);
        return result as ProviderResult<string, ClaudeCLIRaw>;
      };
      return this.#gated(exec);
    },
  };

  // Model providers (direct HTTP API calls — model required per-call)
  readonly model = {
    anthropic: async <T>(
      model: string,
      prompt: string,
      opts?: ModelOpts,
    ): Promise<ProviderResult<T, AnthropicRaw>> => {
      this.#anthropic ??= createAnthropicProvider();
      this.#checkGlobalBudget();
      this.#checkInputBudget(prompt, opts);
      const exec = async () => {
        const result = await this.#anthropic!.execute(prompt, {
          model,
          signal: this.#signal,
          ...opts,
        });
        this.#recordUsage(result.usage);
        this.#checkPostCallUsage(result.usage, opts);
        return { ...result, output: result.output as T } as ProviderResult<T, AnthropicRaw>;
      };
      return this.#gated(exec);
    },

    openai: async <T>(
      model: string,
      prompt: string,
      opts?: ModelOpts,
    ): Promise<ProviderResult<T, OpenAIRaw>> => {
      this.#openai ??= createOpenAIProvider();
      this.#checkGlobalBudget();
      this.#checkInputBudget(prompt, opts);
      const exec = async () => {
        const result = await this.#openai!.execute(prompt, {
          model,
          signal: this.#signal,
          ...opts,
        });
        this.#recordUsage(result.usage);
        this.#checkPostCallUsage(result.usage, opts);
        return { ...result, output: result.output as T } as ProviderResult<T, OpenAIRaw>;
      };
      return this.#gated(exec);
    },
  };
}
