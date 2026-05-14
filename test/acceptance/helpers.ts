import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tuff-accept-'));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// Consumer table fixture reused across journeys
export const ITEMS_SQL = `CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  value TEXT,
  count INTEGER DEFAULT 0
)`;
