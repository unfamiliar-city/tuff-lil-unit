import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tuff } from '../../src/tuff.js';
import type { Progress } from '../../src/types.js';
import { ANTHROPIC_API_KEY, OPENAI_API_KEY, createTempStateDir, cleanupDir } from './helpers.js';

const test = ANTHROPIC_API_KEY ? it : it.skip;
const mixedTest = ANTHROPIC_API_KEY && OPENAI_API_KEY ? it : it.skip;

describe('tuff() — functional end-to-end', () => {
  test('runs a single model step end-to-end', { timeout: 30_000 }, async () => {
    const stateDir = createTempStateDir('single');
    let callCount = 0;

    const runPipeline = () =>
      tuff('functional-single', { stateDir, concurrency: 1 }, async (ctx) => {
        const result = await ctx.model.anthropic('greet', 'claude-haiku-4-5-20251001', 'Say exactly: hello');
        await ctx.step('cache-verify', async () => { callCount++; return 'done'; });
        return result;
      });

    try {
      const result = await runPipeline();
      assert.ok(typeof result === 'string', 'output should be a string');
      assert.ok((result as string).length > 0, 'output should be non-empty');
      assert.equal(callCount, 1, 'step fn executes on first run');

      callCount = 0;
      await runPipeline();
      assert.equal(callCount, 0, 'step fn not re-executed when cached');
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('progress callbacks fire with correct stage/completed/total', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('progress');
    const events: Progress[] = [];

    try {
      await tuff(
        'functional-progress',
        {
          stateDir,
          concurrency: 2,
          onProgress: (p) => events.push({ ...p }),
        },
        async (ctx) => {
          ctx.stage('classify');
          await Promise.all([
            ctx.model.anthropic('c1', 'claude-haiku-4-5-20251001', 'Say: one'),
            ctx.model.anthropic('c2', 'claude-haiku-4-5-20251001', 'Say: two'),
          ]);

          ctx.stage('summarize');
          return ctx.model.anthropic('sum', 'claude-haiku-4-5-20251001', 'Say: summary');
        }
      );

      // Should have events from both stages
      const classifyEvents = events.filter((e) => e.stage === 'classify');
      const summarizeEvents = events.filter((e) => e.stage === 'summarize');

      assert.ok(classifyEvents.length > 0, 'classify stage should produce progress events');
      assert.ok(summarizeEvents.length > 0, 'summarize stage should produce progress events');

      const lastClassify = classifyEvents.at(-1)!;
      assert.equal(lastClassify.completed, 2, 'classify stage should complete 2 steps');
      assert.equal(lastClassify.total, 2, 'classify stage total should be 2');

      const lastSummarize = summarizeEvents.at(-1)!;
      assert.equal(lastSummarize.completed, 1, 'summarize stage should complete 1 step');
      assert.ok(lastSummarize.usage.tokens > 0, 'usage should accumulate across stages');
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('fan-out / fan-in pattern', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('fanout');
    try {
      const result = await tuff(
        'functional-fanout',
        { stateDir, concurrency: 3 },
        async (ctx) => {
          const items = ['red', 'green', 'blue'];

          const descriptions = await Promise.all(
            items.map((color, i) =>
              ctx.model.anthropic(
                `describe-${i}`,
                'claude-haiku-4-5-20251001',
                `In exactly 3 words, describe the color ${color}.`
              )
            )
          );

          const summary = await ctx.model.anthropic(
            'summarize',
            'claude-haiku-4-5-20251001',
            `Summarize these in one sentence: ${(descriptions as string[]).join(', ')}`
          );

          return { descriptions, summary };
        }
      );

      assert.equal((result.descriptions as string[]).length, 3);
      assert.ok(typeof result.summary === 'string');
    } finally {
      cleanupDir(stateDir);
    }
  });

  test('resume: re-run same pipeline, cached steps skip', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('resume');
    let executionCount = 0;

    const runPipeline = () =>
      tuff(
        'functional-resume',
        { stateDir, concurrency: 2 },
        async (ctx) => {
          const r1 = await ctx.model.anthropic(
            'step1',
            'claude-haiku-4-5-20251001',
            'Say exactly: first'
          );
          const r2 = await ctx.step('custom-step', async () => {
            executionCount++;
            return 'computed';
          });
          return { r1, r2 };
        }
      );

    const run1 = await runPipeline();
    assert.equal(executionCount, 1, 'custom-step should execute once');

    executionCount = 0;
    const run2 = await runPipeline();

    assert.equal(executionCount, 0, 'custom-step should be cached on resume');
    assert.deepEqual(run2.r2, run1.r2, 'cached result should match first run');

    cleanupDir(stateDir);
  });

  mixedTest('mixed providers — Anthropic and OpenAI in one pipeline', { timeout: 60_000 }, async () => {
    const stateDir = createTempStateDir('mixed');
    try {
      const result = await tuff(
        'functional-mixed',
        { stateDir, concurrency: 2 },
        async (ctx) => {
          const [fromAnthropic, fromOpenAI] = await Promise.all([
            ctx.model.anthropic('ant', 'claude-haiku-4-5-20251001', 'Say exactly: from anthropic'),
            ctx.model.openai('oai', 'gpt-5-nano', 'Say exactly: from openai'),
          ]);
          return { fromAnthropic, fromOpenAI };
        }
      );

      assert.ok(typeof result.fromAnthropic === 'string');
      assert.ok(typeof result.fromOpenAI === 'string');
    } finally {
      cleanupDir(stateDir);
    }
  });
});
