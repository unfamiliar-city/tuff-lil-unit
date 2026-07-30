import type Database from 'better-sqlite3';
import type { TuffRun, TuffStepFailure } from './schema.js';
import type { TokenUsage } from './types.js';

export class StateManager {
  #db: Database.Database;
  #runId: string;

  constructor(db: Database.Database, runId: string) {
    this.#db = db;
    this.#runId = runId;
  }

  initRun(config: unknown): void {
    const now = new Date().toISOString();
    this.#db.prepare(
      'INSERT INTO tuff_runs (id, config, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(this.#runId, JSON.stringify(config), now, now);
  }

  getRun(): TuffRun | undefined {
    return this.#db.prepare('SELECT * FROM tuff_runs WHERE id = ?').get(this.#runId) as TuffRun | undefined;
  }

  /**
   * Returns the deserialized output for a step, or undefined if not found.
   * Step functions must return JSON-serializable values — Date, Buffer, and
   * class instances silently corrupt on round-trip.
   */
  getStep(stepId: string): unknown {
    const row = this.#db.prepare(
      'SELECT output FROM tuff_steps WHERE run_id = ? AND step_id = ?',
    ).get(this.#runId, stepId) as { output: string } | undefined;

    if (!row) return undefined;
    return JSON.parse(row.output);
  }

  setStep(
    stepId: string,
    output: unknown,
    usage?: TokenUsage,
    durationMs?: number,
  ): void {
    // Provider outputs are already JSON-safe: generateText returns strings,
    // generateObject validates through zod. This guard only catches raw step
    // callbacks returning functions/symbols (→ JSON.stringify returns undefined).
    // Date/Map/Set produce valid-but-lossy JSON — user's responsibility per JSDoc.
    const serialized = JSON.stringify(output);
    if (serialized === undefined) {
      throw new Error(
        `Step '${stepId}' returned a non-JSON-serializable value (function or symbol)`,
      );
    }

    const now = new Date().toISOString();

    // Atomically write success + clear any prior failure record
    this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO tuff_steps (run_id, step_id, output, usage_input, usage_output, usage_cache_read, usage_cache_creation, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_id, step_id) DO UPDATE SET
          output = excluded.output,
          usage_input = excluded.usage_input,
          usage_output = excluded.usage_output,
          usage_cache_read = excluded.usage_cache_read,
          usage_cache_creation = excluded.usage_cache_creation,
          duration_ms = excluded.duration_ms,
          created_at = excluded.created_at
      `).run(
        this.#runId, stepId, serialized,
        usage?.inputTokens ?? 0, usage?.outputTokens ?? 0,
        usage?.cacheReadTokens ?? 0, usage?.cacheCreationTokens ?? 0,
        durationMs ?? null, now,
      );
      this.#db.prepare(
        'DELETE FROM tuff_step_failures WHERE run_id = ? AND step_id = ?',
      ).run(this.#runId, stepId);
    })();
  }

  setStepFailure(stepId: string, error: string, durationMs?: number): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO tuff_step_failures (run_id, step_id, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (run_id, step_id) DO UPDATE SET
        error = excluded.error,
        duration_ms = excluded.duration_ms,
        created_at = excluded.created_at
    `).run(this.#runId, stepId, error, durationMs ?? null, now);
  }

  getStepFailure(stepId: string): TuffStepFailure | undefined {
    return this.#db.prepare(
      'SELECT * FROM tuff_step_failures WHERE run_id = ? AND step_id = ?',
    ).get(this.#runId, stepId) as TuffStepFailure | undefined;
  }

  /** Purge cached output + failure for a step — used by force invalidation. */
  deleteStep(stepId: string): void {
    this.#db.transaction(() => {
      this.#db.prepare(
        'DELETE FROM tuff_steps WHERE run_id = ? AND step_id = ?',
      ).run(this.#runId, stepId);
      this.#db.prepare(
        'DELETE FROM tuff_step_failures WHERE run_id = ? AND step_id = ?',
      ).run(this.#runId, stepId);
    })();
  }

  /** Total steps completed in the previous run — seeds progress prediction on resume. */
  getStepCount(): number {
    const row = this.#db.prepare(
      'SELECT COUNT(*) AS count FROM tuff_steps WHERE run_id = ?',
    ).get(this.#runId) as { count: number };
    return row.count;
  }

  /**
   * Sums token usage across all completed steps — used to restore BudgetManager on resume.
   *
   * Must return the cache buckets too: BudgetManager counts cacheCreationTokens toward the
   * budget total, so omitting them let a resumed run under-count everything it had already
   * spent on cache writes.
   */
  getUsageSummary(): TokenUsage {
    const row = this.#db.prepare(`
      SELECT
        COALESCE(SUM(usage_input), 0) AS input_total,
        COALESCE(SUM(usage_output), 0) AS output_total,
        COALESCE(SUM(usage_cache_read), 0) AS cache_read_total,
        COALESCE(SUM(usage_cache_creation), 0) AS cache_creation_total
      FROM tuff_steps WHERE run_id = ?
    `).get(this.#runId) as {
      input_total: number;
      output_total: number;
      cache_read_total: number;
      cache_creation_total: number;
    };

    return {
      inputTokens: row.input_total,
      outputTokens: row.output_total,
      cacheReadTokens: row.cache_read_total,
      cacheCreationTokens: row.cache_creation_total,
    };
  }
}
