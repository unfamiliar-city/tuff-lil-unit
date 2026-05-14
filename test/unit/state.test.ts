import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { StateManager } from '../../src/state.js';
import { rmSync } from 'node:fs';
import { createTestDb } from '../helpers.js';

const TEST_STATE_DIR = '/tmp/tuff-test-state';
const RUN_ID = 'test-run';

describe('StateManager', () => {
  before(() => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  });

  after(() => {
    rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  });

  test('creates schema and enables WAL mode', () => {
    const db = createTestDb(TEST_STATE_DIR);

    const result = db.pragma('journal_mode', { simple: true });
    assert.equal(result, 'wal');

    db.close();
  });

  test('creates tuff_runs, tuff_steps, tuff_step_failures tables', () => {
    const db = createTestDb(TEST_STATE_DIR);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    assert.ok(tableNames.includes('tuff_runs'));
    assert.ok(tableNames.includes('tuff_steps'));
    assert.ok(tableNames.includes('tuff_step_failures'));

    db.close();
  });

  test('initRun / getRun round-trip', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'run-test');

    state.initRun({ stateDir: TEST_STATE_DIR, concurrency: 4 });

    const run = state.getRun();
    assert.ok(run);
    assert.equal(run.id, 'run-test');
    assert.ok(run.created_at);
    assert.ok(run.updated_at);

    db.close();
  });

  test('getRun returns undefined for missing run', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'missing-run-test');
    const run = state.getRun();
    assert.equal(run, undefined);
    db.close();
  });

  test('getStep / setStep round-trip with JSON serialization', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'step-test');

    assert.equal(state.getStep('step-1'), undefined);

    state.setStep('step-1', { answer: 42, label: 'hello' });

    const result = state.getStep('step-1');
    assert.deepEqual(result, { answer: 42, label: 'hello' });

    db.close();
  });

  test('getStep returns cached null correctly', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'null-step-test');

    state.setStep('step-null', null);
    const result = state.getStep('step-null');
    assert.equal(result, null);

    db.close();
  });

  test('setStep persists usage and duration', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'usage-step-test');

    state.setStep(
      'step-with-usage',
      'output text',
      { inputTokens: 100, outputTokens: 200 },
      1500,
    );

    const row = db
      .prepare('SELECT * FROM tuff_steps WHERE step_id = ?')
      .get('step-with-usage') as {
      usage_input: number;
      usage_output: number;
      duration_ms: number;
    };

    assert.equal(row.usage_input, 100);
    assert.equal(row.usage_output, 200);
    assert.equal(row.duration_ms, 1500);

    db.close();
  });

  test('setStepFailure / getStepFailure', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'failure-test');

    assert.equal(state.getStepFailure('step-fail'), undefined);

    state.setStepFailure('step-fail', 'Error: something went wrong', 500);

    const failure = state.getStepFailure('step-fail');
    assert.ok(failure);
    assert.equal(failure.step_id, 'step-fail');
    assert.equal(failure.error, 'Error: something went wrong');
    assert.equal(failure.duration_ms, 500);
    assert.ok(failure.created_at);

    db.close();
  });

  test('getStepCount returns step count for current run', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'count-test');

    assert.equal(state.getStepCount(), 0);

    state.setStep('step-1', 'a');
    state.setStep('step-2', 'b');
    state.setStep('step-3', 'c');

    assert.equal(state.getStepCount(), 3);

    db.close();
  });

  test('getUsageSummary sums usage across all steps (budget restoration)', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'summary-test');

    state.setStep('s1', 'x', { inputTokens: 100, outputTokens: 50 });
    state.setStep('s2', 'y', { inputTokens: 200, outputTokens: 100 });
    state.setStep('s3', 'z');

    const summary = state.getUsageSummary();
    assert.equal(summary.inputTokens, 300);
    assert.equal(summary.outputTokens, 150);

    db.close();
  });

  test('getUsageSummary returns zeros for empty run', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'empty-summary-test');

    const summary = state.getUsageSummary();
    assert.equal(summary.inputTokens, 0);
    assert.equal(summary.outputTokens, 0);

    db.close();
  });

  test('deleteStep removes step row — getStep returns undefined after delete', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'delete-step-test');

    state.setStep('to-delete', { answer: 42 });
    assert.deepEqual(state.getStep('to-delete'), { answer: 42 });

    state.deleteStep('to-delete');
    assert.equal(state.getStep('to-delete'), undefined);

    db.close();
  });

  test('deleteStep removes failure row — getStepFailure returns undefined after delete', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'delete-failure-test');

    state.setStepFailure('step-f', 'boom', 100);
    assert.ok(state.getStepFailure('step-f'));

    state.deleteStep('step-f');
    assert.equal(state.getStepFailure('step-f'), undefined);

    db.close();
  });

  test('deleteStep on nonexistent id — does not throw', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'delete-noexist-test');

    assert.doesNotThrow(() => state.deleteStep('ghost'));

    db.close();
  });

  test('deleteStep clears both tables atomically — seed both, delete, verify both gone', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'delete-atomic-test');

    state.setStep('combo-step', 'val');
    state.setStepFailure('combo-step', 'prior error', 50);

    assert.deepEqual(state.getStep('combo-step'), 'val');
    assert.ok(state.getStepFailure('combo-step'));

    state.deleteStep('combo-step');

    assert.equal(state.getStep('combo-step'), undefined);
    assert.equal(state.getStepFailure('combo-step'), undefined);

    db.close();
  });

  test('setStep throws on non-JSON-serializable value', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'serialize-test');

    assert.throws(
      () => state.setStep('bad-step', () => {}),
      /non-JSON-serializable/,
    );

    db.close();
  });

  test('WAL mode and close cleans up without throwing', () => {
    const db = createTestDb(TEST_STATE_DIR);
    const state = new StateManager(db, 'close-test');
    state.setStep('s', 'val');
    db.close();
  });

  test('close and reopen preserves state (durability)', () => {
    const runId = 'durability-test';
    let db = createTestDb(TEST_STATE_DIR);
    let state = new StateManager(db, runId);

    state.initRun({ stateDir: TEST_STATE_DIR });
    state.setStep('step-1', { value: 'persisted' }, { inputTokens: 10, outputTokens: 5 });
    db.close();

    db = createTestDb(TEST_STATE_DIR);
    state = new StateManager(db, runId);
    const run = state.getRun();
    assert.ok(run);

    const result = state.getStep('step-1');
    assert.deepEqual(result, { value: 'persisted' });

    const summary = state.getUsageSummary();
    assert.equal(summary.inputTokens, 10);
    assert.equal(summary.outputTokens, 5);

    db.close();
  });
});
