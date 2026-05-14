import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderResult } from '../../src/types.js';
import assert from 'node:assert/strict';

export const OPENAI_API_KEY: string | undefined = process.env.OPENAI_API_KEY;
export const ANTHROPIC_API_KEY: string | undefined = process.env.ANTHROPIC_API_KEY;

export const HAS_CLAUDE_CLI: boolean = (() => {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export function createTempStateDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `tuff-functional-${prefix}-`));
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export function assertValidProviderResult(result: ProviderResult): void {
  assert.equal(typeof result.output, 'string', 'output must be a string');
  assert.ok((result.output as string).length > 0, 'output must be non-empty');
  assert.ok(result.usage.inputTokens > 0, 'inputTokens must be > 0');
  assert.ok(result.usage.outputTokens > 0, 'outputTokens must be > 0');
  assert.ok(result.durationMs > 0, 'durationMs must be > 0');
}
