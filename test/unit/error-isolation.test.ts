/**
 * Tests for error isolation — verifying that per-step errors (timeouts, SDK errors)
 * don't cascade into pipeline-level aborts.
 *
 * Motivated by: GPT call timeout throwing DOMException [AbortError], which tuff
 * conflated with pipeline-level abort, killing all queued steps.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, AbortError } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { classifyError } from '../../src/retry.js';
import { createTestDb } from '../helpers.js';

function makeContext(opts: {
  concurrency?: number;
  signal?: AbortSignal;
  stateDir?: string;
}) {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'err-iso-'));
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  const db = createTestDb(stateDir);
  const state = new StateManager(db, runId);
  const controller = new AbortController();
  const ctx = new Context({
    id: runId,
    concurrency: opts.concurrency ?? 5,
    signal: opts.signal ?? controller.signal,
    state,
    budgetManager: new BudgetManager(),
    db,
  });
  return { ctx, state, controller, stateDir, db };
}

describe('Error isolation: external AbortError vs pipeline abort', () => {
  test('step fn throwing AbortError does NOT trigger pipeline abort', async () => {
    const { ctx, state, stateDir, db } = makeContext({});

    // Simulate what the Vercel AI SDK does on timeout:
    // a DOMException with name 'AbortError' thrown from inside a step
    const abortError = new DOMException('This operation was aborted', 'AbortError');

    await assert.rejects(
      () => ctx.step('timeout-step', async () => { throw abortError; }),
    );

    // The step failure should be recorded (not swallowed as pipeline abort)
    const failure = state.getStepFailure('timeout-step');
    assert.ok(failure, 'step failure should be recorded for external AbortError');
    assert.ok(failure.error.includes('aborted'), 'failure should contain original message');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('step fn throwing AbortError does not abort sibling steps', async () => {
    const { ctx, stateDir, db } = makeContext({ concurrency: 1 });

    const results = await Promise.allSettled([
      ctx.step('ok-1', async () => 'first'),
      ctx.step('abort-fail', async () => {
        throw new DOMException('timeout', 'AbortError');
      }),
      ctx.step('ok-2', async () => 'third'),
    ]);

    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    assert.equal(results[2]!.status, 'fulfilled');
    assert.equal((results[2] as PromiseFulfilledResult<string>).value, 'third');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('pipeline signal abort still works when step throws AbortError', async () => {
    const controller = new AbortController();
    const { ctx, stateDir, db } = makeContext({
      concurrency: 1,
      signal: controller.signal,
    });

    // Abort the pipeline signal, then try a step
    controller.abort();

    await assert.rejects(
      () => ctx.step('after-abort', async () => 'nope'),
      AbortError,
      'pipeline-level abort should still throw AbortError',
    );

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Retry classification: timeout and AbortError', () => {
  test('AbortError classified as transient (retriable)', () => {
    const error = new DOMException('This operation was aborted', 'AbortError');
    const result = classifyError(error);
    assert.equal(result.type, 'transient');
    assert.equal(result.retriable, true);
  });

  test('"timed out" message classified as transient (retriable)', () => {
    const error = new Error('LLM call timed out after 60000ms');
    const result = classifyError(error);
    assert.equal(result.type, 'transient');
    assert.equal(result.retriable, true);
  });

  test('AbortError takes precedence over permanent default', () => {
    // Before the fix, this would fall through to { type: 'permanent', retriable: false }
    const error = { name: 'AbortError', message: 'The operation was aborted' };
    const result = classifyError(error);
    assert.equal(result.retriable, true, 'AbortError should not be classified as permanent');
  });
});
