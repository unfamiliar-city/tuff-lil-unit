// Token usage from LLM API calls
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

// Result from a provider execution
export interface ProviderResult<T = unknown, R = unknown> {
  output: T;
  usage: TokenUsage;
  durationMs: number;
  raw: R;
}

// Progress update from a running pipeline
export interface Progress {
  stage: string;
  completed: number;
  total: number;
  usage: { tokens: number };
}

/** Per-step budget limits — controls token spend on individual steps. */
export interface StepBudget {
  /** Cap output tokens (API-enforced for LLM providers, total-token kill-threshold for Claude CLI). */
  maxTokens?: number;
  /** Pre-call input token check — refuses execution if estimated input exceeds limit. */
  maxInputTokens?: number;
  /** Behavior when post-call actual usage exceeds limits. Default: 'throw'. */
  onExceed?: 'throw' | 'warn';
  /** Override the default chars/4 estimator for pre-call input checks. */
  tokenEstimator?: (text: string) => number;
}

// Configuration for a tuff() run
export interface TuffConfig {
  stateDir: string;
  /** Max steps to run in parallel. Defaults to 5 — conservative for rate-limited LLM APIs. */
  concurrency?: number;
  budget?: { tokens: number };
  onProgress?: (progress: Progress) => void;
  /** Register SIGTERM/SIGINT handlers for graceful abort. Default: false. */
  handleProcessSignals?: boolean;
  /**
   * Additional SQL CREATE TABLE statements to execute at startup.
   * @example
   * const setup = ['CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, title TEXT)'];
   * tuff('id', { stateDir, setup }, async (ctx) => { ... });
   */
  setup?: string[];
}
