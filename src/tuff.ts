import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { BudgetManager } from './budget.js';
import { Context } from './context.js';
import { SCHEMA_SQL } from './schema.js';
import { syncSchema } from './schema-sync.js';
import { StateManager } from './state.js';
import type { DurableConfig } from './types.js';

/**
 * Run a durable pipeline with step memoization. Call again with the same id to
 * resume — cached steps return instantly, execution continues from first uncached step.
 */
export async function tuff<T>(
  id: string,
  config: DurableConfig,
  fn: (ctx: Context) => Promise<T>,
): Promise<T> {
  if (!id) throw new Error('tuff: id must be a non-empty string');
  if (!config.stateDir) throw new Error('tuff: stateDir is required');
  if (config.concurrency !== undefined && (config.concurrency < 1 || !Number.isInteger(config.concurrency))) {
    throw new Error('tuff: concurrency must be a positive integer');
  }
  if (config.budget?.tokens !== undefined && config.budget.tokens < 1) {
    throw new Error('tuff: budget.tokens must be positive');
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  if (config.handleProcessSignals) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  mkdirSync(config.stateDir, { recursive: true });
  const db = new Database(`${config.stateDir}/tuff.db`);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  syncSchema(db, [...SCHEMA_SQL, ...(config.setup ?? [])]);

  const state = new StateManager(db, id);

  // Resume detection: if run exists, continue; otherwise initialize
  if (!state.getRun()) {
    const { setup: _setup, ...serializableConfig } = config;
    state.initRun(serializableConfig);
  }

  // Restore budget from prior run so remaining budget is accurate on resume
  const budgetManager = new BudgetManager(config.budget);
  const priorUsage = state.getUsageSummary();
  if (priorUsage.inputTokens > 0 || priorUsage.outputTokens > 0) {
    budgetManager.consume(priorUsage);
  }

  const ctx = new Context({
    id,
    concurrency: config.concurrency ?? 5,
    onProgress: config.onProgress,
    signal: controller.signal,
    state,
    budgetManager,
    db,
  });

  try {
    return await fn(ctx);
  } catch (error) {
    // Log before aborting — queued steps will throw AbortError, masking this root cause
    console.error('[tuff] Pipeline error:', error);
    controller.abort();
    throw error;
  } finally {
    if (config.handleProcessSignals) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    db.close();
  }
}
