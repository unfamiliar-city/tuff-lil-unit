import { describe, it, mock, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranscriptTokens,
  createWorkerDir,
  deriveTranscriptDir,
  cleanupWorkerDir,
  monitorBudget,
  ClaudeCLIProvider,
} from '../../../src/providers/claude-cli.js';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/** Build a JSONL assistant message with usage data. */
function usageLine(input: number, output: number, cacheCreation = 0, cacheRead = 0): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

/** Create a unique /tmp dir for transcript tests. */
function tmpTranscriptDir(label: string): string {
  const dir = `/tmp/tuff-monitor-${label}-${Date.now()}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** EventEmitter that satisfies the `proc` shape monitorBudget needs. */
function fakeProc(): EventEmitter & { kill: ReturnType<typeof mock.fn> } {
  const emitter = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof mock.fn> };
  emitter.kill = mock.fn();
  return emitter;
}

describe('parseTranscriptTokens', () => {
  it('parses valid JSONL with usage data', () => {
    const tmpFile = '/tmp/test-transcript.jsonl';
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 1000,
          },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 150,
            output_tokens: 250,
            cache_creation_input_tokens: 75,
            cache_read_input_tokens: 2000,
          },
        },
      }),
    ].join('\n');

    writeFileSync(tmpFile, content);

    const usage = parseTranscriptTokens(tmpFile);

    assert.equal(usage.inputTokens, 250);
    assert.equal(usage.outputTokens, 450);
    assert.equal(usage.cacheCreationTokens, 125);
    assert.equal(usage.cacheReadTokens, 3000);

    rmSync(tmpFile, { force: true });
  });

  it('ignores non-assistant entries', () => {
    const tmpFile = '/tmp/test-transcript-2.jsonl';
    const content = [
      JSON.stringify({
        type: 'user',
        message: { usage: { input_tokens: 100, output_tokens: 200 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 50, output_tokens: 75 } },
      }),
    ].join('\n');

    writeFileSync(tmpFile, content);

    const usage = parseTranscriptTokens(tmpFile);
    assert.equal(usage.inputTokens, 50);
    assert.equal(usage.outputTokens, 75);

    rmSync(tmpFile, { force: true });
  });

  it('handles entries without usage field', () => {
    const tmpFile = '/tmp/test-transcript-3.jsonl';
    const content = [
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 100, output_tokens: 200 } },
      }),
    ].join('\n');

    writeFileSync(tmpFile, content);

    const usage = parseTranscriptTokens(tmpFile);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 200);

    rmSync(tmpFile, { force: true });
  });

  it('returns zero for non-existent file', () => {
    const usage = parseTranscriptTokens('/tmp/nonexistent-transcript.jsonl');
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
  });

  it('handles malformed JSONL gracefully', () => {
    const tmpFile = '/tmp/test-transcript-4.jsonl';
    const content = [
      'invalid json',
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 100, output_tokens: 200 } },
      }),
    ].join('\n');

    writeFileSync(tmpFile, content);

    const usage = parseTranscriptTokens(tmpFile);
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 200);

    rmSync(tmpFile, { force: true });
  });

  it('handles empty file', () => {
    const tmpFile = '/tmp/test-transcript-5.jsonl';
    writeFileSync(tmpFile, '');

    const usage = parseTranscriptTokens(tmpFile);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);

    rmSync(tmpFile, { force: true });
  });
});

describe('createWorkerDir', () => {
  it('creates worker directory in /tmp', () => {
    const jobId = 'test-job-123';
    const workDir = createWorkerDir(jobId);

    assert.equal(workDir, `/tmp/tuff-worker-${jobId}`);
    assert.ok(existsSync(workDir));

    rmSync(workDir, { recursive: true, force: true });
  });
});

describe('deriveTranscriptDir', () => {
  it('derives transcript directory from work dir', () => {
    const workDir = '/tmp/tuff-worker-test';
    mkdirSync(workDir, { recursive: true });

    const transcriptDir = deriveTranscriptDir(workDir);

    assert.ok(transcriptDir.includes('.claude/projects/'));
    assert.ok(transcriptDir.includes('tuff-worker-test'));

    rmSync(workDir, { recursive: true, force: true });
  });

  it('uses realpathSync to resolve symlinks', () => {
    const workDir = '/tmp/tuff-worker-realpath-test';
    mkdirSync(workDir, { recursive: true });

    const transcriptDir = deriveTranscriptDir(workDir);
    assert.ok(transcriptDir.includes('-private-') || transcriptDir.includes('-tmp-'));

    rmSync(workDir, { recursive: true, force: true });
  });
});

describe('cleanupWorkerDir', () => {
  it('removes worker directory', () => {
    const workDir = '/tmp/tuff-worker-cleanup-test';
    mkdirSync(workDir, { recursive: true });

    assert.ok(existsSync(workDir));
    cleanupWorkerDir(workDir);
    assert.ok(!existsSync(workDir));
  });

  it('handles non-existent directory gracefully', () => {
    cleanupWorkerDir('/tmp/tuff-worker-nonexistent');
  });

  it('removes directory with contents', () => {
    const workDir = '/tmp/tuff-worker-cleanup-test-2';
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'test.txt'), 'content');

    cleanupWorkerDir(workDir);
    assert.ok(!existsSync(workDir));
  });
});

describe('ClaudeCLIProvider', () => {
  it('constructs without config — model is required in execute options', () => {
    const provider = new ClaudeCLIProvider();
    assert.equal(typeof provider.execute, 'function');
  });

});

describe('monitorBudget', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('sends SIGTERM when JSONL tokens exceed budget', async () => {
    const dir = tmpTranscriptDir('kill');
    dirs.push(dir);
    writeFileSync(join(dir, 'transcript.jsonl'), usageLine(300, 200));

    const proc = fakeProc();
    // Budget 400 — total is 500 (300+200) which exceeds it
    const promise = monitorBudget(dir, 400, proc as never);

    // Wait for the poll loop to fire and detect the overage
    await new Promise((resolve) => setTimeout(resolve, 250));
    // monitorBudget should have killed the proc — emit exit to resolve the promise
    proc.emit('exit', 1);

    const usage = await promise;
    assert.equal(proc.kill.mock.callCount(), 1);
    assert.deepEqual(proc.kill.mock.calls[0]!.arguments, ['SIGTERM']);
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.outputTokens, 200);
  });

  it('resolves with final usage when process exits normally', async () => {
    const dir = tmpTranscriptDir('exit');
    dirs.push(dir);
    writeFileSync(join(dir, 'transcript.jsonl'), usageLine(100, 50));

    const proc = fakeProc();
    const promise = monitorBudget(dir, 99999, proc as never);

    // Let the poll find the transcript, then exit cleanly
    await new Promise((resolve) => setTimeout(resolve, 250));
    proc.emit('exit', 0);

    const usage = await promise;
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.equal(proc.kill.mock.callCount(), 0);
  });

  it('throws when no transcript file appears within 5s', async (t: TestContext) => {
    const dir = tmpTranscriptDir('timeout');
    dirs.push(dir);
    // Don't create any .jsonl file — directory exists but is empty

    const proc = fakeProc();

    // Mock both setTimeout and Date so Date.now() advances with tick()
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const promise = monitorBudget(dir, 99999, proc as never);

    // Tick in increments, flushing microtasks between each so the
    // async while loop can iterate through each 100ms sleep
    for (let i = 0; i < 55; i++) {
      t.mock.timers.tick(100);
      await Promise.resolve();
    }

    await assert.rejects(promise, { message: /Transcript not found after 5s/ });
  });

  it('resolves with last usage when AbortSignal fires mid-monitor', async () => {
    const dir = tmpTranscriptDir('abort');
    dirs.push(dir);
    writeFileSync(join(dir, 'transcript.jsonl'), usageLine(80, 40));

    const proc = fakeProc();
    const controller = new AbortController();
    const promise = monitorBudget(dir, 99999, proc as never, controller.signal);

    // Wait for the poll to read at least once
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();

    const usage = await promise;
    // Should resolve with the last-read usage, NOT kill the process
    assert.equal(usage.inputTokens, 80);
    assert.equal(usage.outputTokens, 40);
    assert.equal(proc.kill.mock.callCount(), 0);
  });

  it('accumulates tokens across multiple JSONL entries before tripping', async () => {
    const dir = tmpTranscriptDir('accumulate');
    dirs.push(dir);
    // Each entry alone is under budget (300), but combined total is 400
    const content = [usageLine(100, 50), usageLine(100, 50), usageLine(30, 20)].join('\n');
    writeFileSync(join(dir, 'transcript.jsonl'), content);

    const proc = fakeProc();
    // Budget 300 — total is 350 (230 input + 120 output) which exceeds
    const promise = monitorBudget(dir, 300, proc as never);

    await new Promise((resolve) => setTimeout(resolve, 250));
    proc.emit('exit', 1);

    const usage = await promise;
    assert.equal(proc.kill.mock.callCount(), 1);
    assert.equal(usage.inputTokens, 230);
    assert.equal(usage.outputTokens, 120);
  });

  it('does NOT trip budget when high cacheReadTokens inflate apparent usage', async () => {
    const dir = tmpTranscriptDir('cache-read');
    dirs.push(dir);
    // 50 input + 50 output = 100 billable, well under budget of 500
    // But cacheReadTokens is 10000 — should be excluded from budget calc
    writeFileSync(join(dir, 'transcript.jsonl'), usageLine(50, 50, 0, 10000));

    const proc = fakeProc();
    const promise = monitorBudget(dir, 500, proc as never);

    await new Promise((resolve) => setTimeout(resolve, 250));
    proc.emit('exit', 0);

    const usage = await promise;
    assert.equal(proc.kill.mock.callCount(), 0);
    assert.equal(usage.cacheReadTokens, 10000);
    assert.equal(usage.inputTokens, 50);
  });

  it('trips budget when cacheCreationTokens push total over limit', async () => {
    const dir = tmpTranscriptDir('cache-create');
    dirs.push(dir);
    // 50 input + 50 output + 500 cacheCreation = 600, over budget of 500
    writeFileSync(join(dir, 'transcript.jsonl'), usageLine(50, 50, 500, 0));

    const proc = fakeProc();
    const promise = monitorBudget(dir, 500, proc as never);

    await new Promise((resolve) => setTimeout(resolve, 250));
    proc.emit('exit', 1);

    const usage = await promise;
    assert.equal(proc.kill.mock.callCount(), 1);
    assert.equal(usage.cacheCreationTokens, 500);
  });
});
