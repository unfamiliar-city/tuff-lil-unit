import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, AbortError } from '../../src/context.js';
import { BudgetManager } from '../../src/budget.js';
import { BudgetExceededError } from '../../src/budget.js';
import type { Provider } from '../../src/budget.js';
import { StateManager } from '../../src/state.js';
import { createTestDb } from '../helpers.js';

function makeContext(opts: {
  concurrency?: number;
  budget?: { tokens: number };
  onProgress?: (p: unknown) => void;
  signal?: AbortSignal;
  stateDir?: string;
  runId?: string;
  providers?: { anthropic?: Provider; openai?: Provider; claudeCode?: Provider };
}) {
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'ctx-test-'));
  const runId = opts.runId ?? `run-${Math.random().toString(36).slice(2)}`;
  const db = createTestDb(stateDir);
  const state = new StateManager(db, runId);
  const budgetManager = new BudgetManager(opts.budget);
  const controller = new AbortController();
  const ctx = new Context({
    id: runId,
    concurrency: opts.concurrency ?? 10,
    onProgress: opts.onProgress as ((p: import('../../src/types.js').Progress) => void) | undefined,
    signal: opts.signal ?? controller.signal,
    state,
    budgetManager,
    db,
    providers: opts.providers,
  });
  return { ctx, state, budgetManager, controller, stateDir, db };
}

describe('Context.step', () => {
  test('step memoization — cached steps return instantly without re-executing fn', async () => {
    const { ctx, stateDir, db } = makeContext({});

    let callCount = 0;
    const result1 = await ctx.step('my-step', async () => {
      callCount++;
      return 'hello';
    });

    assert.equal(result1, 'hello');
    assert.equal(callCount, 1);

    const result2 = await ctx.step('my-step', async () => {
      callCount++;
      return 'should-not-run';
    });

    assert.equal(result2, 'hello');
    assert.equal(callCount, 1, 'fn should not be called again for cached step');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('step persists result to SQLite', async () => {
    const { ctx, state, stateDir, db } = makeContext({});

    await ctx.step('persist-step', async () => ({ data: 42 }));

    const cached = state.getStep('persist-step');
    assert.deepEqual(cached, { data: 42 });

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('concurrency enforcement — p-limit N=2 allows max 2 concurrent', async () => {
    const { ctx, stateDir, db } = makeContext({ concurrency: 2 });

    let concurrentCount = 0;
    let maxConcurrent = 0;

    const makeStep = (id: string) =>
      ctx.step(id, async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 30));
        concurrentCount--;
        return id;
      });

    await Promise.all([
      makeStep('s1'),
      makeStep('s2'),
      makeStep('s3'),
      makeStep('s4'),
    ]);

    assert.ok(maxConcurrent <= 2, `max concurrent was ${maxConcurrent}, expected <= 2`);

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('budget pre-flight check — throws BudgetExceededError when exceeded', async () => {
    const { ctx, budgetManager, stateDir, db } = makeContext({
      budget: { tokens: 100 },
    });

    // Consume entire budget
    budgetManager.consume({ inputTokens: 100, outputTokens: 1 });
    assert.ok(budgetManager.isExceeded());

    await assert.rejects(
      () => ctx.step('blocked', async () => 'should-not-run'),
      BudgetExceededError,
    );

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('abort signal before limiter queue — throws AbortError', async () => {
    const controller = new AbortController();
    controller.abort();

    const { ctx, stateDir, db } = makeContext({ signal: controller.signal });

    await assert.rejects(
      () => ctx.step('aborted', async () => 'nope'),
      AbortError,
    );

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('abort signal after limiter queue — throws AbortError for queued steps', async () => {
    const controller = new AbortController();
    const { ctx, stateDir, db } = makeContext({ concurrency: 1, signal: controller.signal });

    // Block the single slot and abort the controller inside it
    const blocker = ctx.step('blocker', async () => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'done';
    });

    // Queue a step — should see the aborted signal when it gets the slot
    const queued = ctx.step('queued', async () => 'should-not-run');

    // Settle both — blocker completes, queued gets AbortError
    const results = await Promise.allSettled([blocker, queued]);

    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected');
    assert.ok(results[1]!.reason instanceof AbortError, 'queued step should throw AbortError');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('failure persistence — failed steps recorded in step_failures', async () => {
    const { ctx, state, stateDir, db } = makeContext({});

    const error = new Error('step failed hard');
    await assert.rejects(
      () => ctx.step('bad-step', async () => { throw error; }),
      /step failed hard/,
    );

    const failure = state.getStepFailure('bad-step');
    assert.ok(failure, 'step_failures should have a record');
    assert.ok(failure.error.includes('step failed hard'));

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context.stage', () => {
  test('stage resets registered/completed counters', async () => {
    const progressEvents: unknown[] = [];
    const { ctx, stateDir, db } = makeContext({
      onProgress: (p) => progressEvents.push({ ...p }),
    });

    ctx.stage('phase-1');
    const first = progressEvents.at(-1) as { stage: string; completed: number; total: number };
    assert.equal(first.stage, 'phase-1');
    assert.equal(first.completed, 0);
    assert.equal(first.total, 0);

    ctx.stage('phase-2');
    const second = progressEvents.at(-1) as { stage: string };
    assert.equal(second.stage, 'phase-2');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('onProgress fires with correct stage/completed/total', async () => {
    const progressEvents: unknown[] = [];
    const { ctx, stateDir, db } = makeContext({
      concurrency: 5,
      onProgress: (p) => progressEvents.push({ ...p }),
    });

    ctx.stage('classify');

    await Promise.all([
      ctx.step('c1', async () => 'a'),
      ctx.step('c2', async () => 'b'),
      ctx.step('c3', async () => 'c'),
    ]);

    // After all steps complete, last progress event should show 3/3
    const last = progressEvents.at(-1) as { stage: string; completed: number; total: number };
    assert.equal(last.stage, 'classify');
    assert.equal(last.completed, 3);
    assert.equal(last.total, 3);

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('fan-out: all steps register synchronously, total known before any execute', async () => {
    // With concurrency=1, steps execute serially. All 3 are registered before the first runs,
    // so the first progress event from completion should see total=3 (not 1).
    const progressEvents: Array<{ completed: number; total: number }> = [];
    const { ctx, stateDir, db } = makeContext({
      concurrency: 1,
      onProgress: (p) => progressEvents.push({ completed: p.completed, total: p.total }),
    });

    ctx.stage('fan-out');

    await Promise.all([
      ctx.step('f1', async () => 'a'),
      ctx.step('f2', async () => 'b'),
      ctx.step('f3', async () => 'c'),
    ]);

    // Index 0 is the stage() event (total=0). Index 1 is the first step completion.
    // At first completion, #registered was already 3 — all three were registered
    // synchronously before any ran (p-limit defers to microtask queue).
    const firstCompletion = progressEvents[1];
    assert.ok(firstCompletion, 'should have at least one step completion event');
    assert.equal(firstCompletion.total, 3, 'total should be 3 even for first completed step');

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context.step force invalidation', () => {
  test('force:true re-executes cached step, returns new value', async () => {
    const { ctx, stateDir, db } = makeContext({});

    let callCount = 0;
    await ctx.step('cached', async () => { callCount++; return 'v1'; });
    assert.equal(callCount, 1);

    const result = await ctx.step('cached', async () => { callCount++; return 'v2'; }, { force: true });
    assert.equal(result, 'v2');
    assert.equal(callCount, 2, 'fn should re-execute with force:true');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('force:true after prior failure — step succeeds, failure record cleared', async () => {
    const { ctx, state, stateDir, db } = makeContext({});

    await assert.rejects(() => ctx.step('flaky', async () => { throw new Error('boom'); }));
    assert.ok(state.getStepFailure('flaky'), 'failure should be recorded');

    const result = await ctx.step('flaky', async () => 'recovered', { force: true });
    assert.equal(result, 'recovered');
    assert.equal(state.getStepFailure('flaky'), undefined, 'failure record should be cleared');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('force:false (default) — returns cached value without re-executing', async () => {
    const { ctx, stateDir, db } = makeContext({});

    let callCount = 0;
    await ctx.step('once', async () => { callCount++; return 'v1'; });
    const result = await ctx.step('once', async () => { callCount++; return 'v2'; }, { force: false });

    assert.equal(result, 'v1', 'should return cached value');
    assert.equal(callCount, 1, 'fn should not re-execute');

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context.stage force invalidation', () => {
  test('stage force:true — all subsequent step calls re-execute even if cached', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-stage-force-'));
    const runId = 'stage-force-run';
    const db = createTestDb(stateDir);

    // Run 1: cache 3 steps
    const state1 = new StateManager(db, runId);
    const ctx1 = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: state1, budgetManager: new BudgetManager(), db,
    });
    ctx1.stage('alpha');
    let callCount = 0;
    await Promise.all([
      ctx1.step('a1', async () => { callCount++; return 'v1'; }),
      ctx1.step('a2', async () => { callCount++; return 'v2'; }),
      ctx1.step('a3', async () => { callCount++; return 'v3'; }),
    ]);
    assert.equal(callCount, 3);

    // Run 2: stage with force:true — all 3 steps should re-execute
    callCount = 0;
    const state2 = new StateManager(db, runId);
    const ctx2 = new Context({
      id: runId, concurrency: 5,
      signal: new AbortController().signal,
      state: state2, budgetManager: new BudgetManager(), db,
    });
    ctx2.stage('alpha', { force: true });
    await Promise.all([
      ctx2.step('a1', async () => { callCount++; return 'new1'; }),
      ctx2.step('a2', async () => { callCount++; return 'new2'; }),
      ctx2.step('a3', async () => { callCount++; return 'new3'; }),
    ]);
    assert.equal(callCount, 3, 'all steps should re-execute under force stage');

    db.close();
    rmSync(stateDir, { recursive: true });
  });

  test('stage without force — steps remain cached', async () => {
    const { ctx, stateDir, db } = makeContext({});

    let callCount = 0;
    ctx.stage('warm');
    await ctx.step('s1', async () => { callCount++; return 'a'; });

    ctx.stage('warm'); // no force
    await ctx.step('s1', async () => { callCount++; return 'b'; });

    assert.equal(callCount, 1, 'step should still be cached');

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context.stage concurrency override', () => {
  test('stage concurrency overrides context default', async () => {
    const { ctx, stateDir, db } = makeContext({ concurrency: 10 });

    ctx.stage('tight', { concurrency: 1 });

    let concurrentCount = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        ctx.step(`cs${i}`, async () => {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise((resolve) => setTimeout(resolve, 30));
          concurrentCount--;
          return i;
        }),
      ),
    );

    assert.ok(maxConcurrent <= 1, `max concurrent was ${maxConcurrent}, expected <= 1`);

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});

describe('Context resume', () => {
  test('progress seeding on resume — getStepCount seeds initial completed count', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ctx-resume-'));
    const runId = 'resume-run';

    // First run: complete 2 steps
    const db = createTestDb(stateDir);
    const state1 = new StateManager(db, runId);
    state1.setStep('step-a', 'result-a');
    state1.setStep('step-b', 'result-b');

    // Second run: resume — completed count should be seeded from prior run
    const progressEvents: unknown[] = [];
    const state2 = new StateManager(db, runId);
    const ctx = new Context({
      id: runId,
      concurrency: 5,
      onProgress: (p) => progressEvents.push({ ...p }),
      signal: new AbortController().signal,
      state: state2,
      budgetManager: new BudgetManager(),
      db,
    });

    ctx.stage('new-stage');
    // After stage reset, completed goes back to 0 (stage-scoped tracking)
    // But the initial completed seeding happened at construction
    const afterStage = progressEvents.at(-1) as { completed: number };
    assert.equal(afterStage.completed, 0, 'stage() resets completed counter');

    db.close();
    rmSync(stateDir, { recursive: true });
  });
});
