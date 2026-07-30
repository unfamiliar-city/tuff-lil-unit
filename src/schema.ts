export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS tuff_runs (
    id TEXT PRIMARY KEY,
    config TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tuff_steps (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    output TEXT NOT NULL,
    usage_input INTEGER NOT NULL DEFAULT 0,
    usage_output INTEGER NOT NULL DEFAULT 0,
    usage_cache_read INTEGER NOT NULL DEFAULT 0,
    usage_cache_creation INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tuff_step_failures (
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    error TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, step_id)
  )`,
];

export interface TuffRun {
  id: string;
  config: string | null;
  created_at: string;
  updated_at: string;
}

export interface TuffStep {
  run_id: string;
  step_id: string;
  output: string;
  usage_input: number;
  usage_output: number;
  usage_cache_read: number;
  usage_cache_creation: number;
  duration_ms: number | null;
  created_at: string;
}

export interface TuffStepFailure {
  run_id: string;
  step_id: string;
  error: string;
  duration_ms: number | null;
  created_at: string;
}
