import type { ProviderResult, TokenUsage } from '../types.js';
import type { Provider } from './base.js';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  realpathSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseTranscriptTokens(filePath: string): TokenUsage {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  }
  const lines = content.trim().split('\n').filter((line) => line.length > 0);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'assistant' && entry.message?.usage) {
        const usage = entry.message.usage;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        cacheReadTokens += usage.cache_read_input_tokens || 0;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}

export function createWorkerDir(jobId: string): string {
  const workDir = `/tmp/tuff-worker-${jobId}`;
  mkdirSync(workDir, { recursive: true });
  return workDir;
}

export function deriveTranscriptDir(workDir: string): string {
  const realPath = realpathSync(workDir);
  const projectDir = realPath.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', projectDir);
}

/** Poll for a .jsonl transcript file in the given directory, waiting up to timeoutMs. */
export async function findTranscriptFile(
  transcriptDir: string,
  timeoutMs: number = 5000,
): Promise<string | undefined> {
  const waitStart = Date.now();
  while (Date.now() - waitStart < timeoutMs) {
    try {
      const files = readdirSync(transcriptDir);
      const jsonlFiles = files.filter(
        (f) => f.endsWith('.jsonl') && !f.includes('subagents'),
      );
      if (jsonlFiles.length > 0) {
        return join(transcriptDir, jsonlFiles[0]!);
      }
    } catch {
      // Directory may not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

export function cleanupWorkerDir(workDir: string): void {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

export async function monitorBudget(
  transcriptDir: string,
  budgetTokens: number,
  proc: ReturnType<typeof spawn>,
  signal?: AbortSignal
): Promise<TokenUsage> {
  const transcriptPath = await findTranscriptFile(transcriptDir);
  if (!transcriptPath) {
    throw new Error('Transcript not found after 5s');
  }

  let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let intervalId: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    intervalId = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(intervalId);
        resolve(finalUsage);
        return;
      }

      try {
        const usage = parseTranscriptTokens(transcriptPath!);
        finalUsage = usage;

        const totalTokens =
          usage.inputTokens + usage.outputTokens + (usage.cacheCreationTokens ?? 0);
        if (totalTokens > budgetTokens) {
          proc.kill('SIGTERM');
          clearInterval(intervalId);
        }
      } catch {
        // Transcript may be partially written
      }
    }, 100);

    proc.on('exit', () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
      try {
        finalUsage = parseTranscriptTokens(transcriptPath!);
      } catch {
        // Use last known usage
      }
      resolve(finalUsage);
    });
  });
}

export interface ClaudeCLIRaw {
  stdout: string;
  transcriptPath: string | undefined;
}

export class ClaudeCLIProvider implements Provider<ClaudeCLIRaw> {
  async execute(
    prompt: string,
    options: { model: string; maxTokens?: number; signal?: AbortSignal } & Record<string, unknown>
  ): Promise<ProviderResult<unknown, ClaudeCLIRaw>> {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const startTime = Date.now();

    let workDir: string | undefined;

    try {
      workDir = createWorkerDir(jobId);
      const transcriptDir = deriveTranscriptDir(workDir);

      // Strip CLAUDECODE (nested-session guard) and ANTHROPIC_API_KEY (CLI uses
      // its own stored credentials; a caller-injected key would override them)
      const { CLAUDECODE: _cc, ANTHROPIC_API_KEY: _ak, ...spawnEnv } = process.env;
      const proc = spawn('claude', ['-p', '--model', options.model], {
        cwd: workDir,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      const abortHandler = () => {
        proc.kill('SIGTERM');
      };

      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler);
      }

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let monitorPromise: Promise<TokenUsage> | undefined;
      if (options.maxTokens) {
        monitorPromise = monitorBudget(transcriptDir, options.maxTokens, proc, options.signal);
      }

      const exitCode = await new Promise<number>((resolve, reject) => {
        proc.on('exit', (code) => {
          if (options.signal) {
            options.signal.removeEventListener('abort', abortHandler);
          }
          resolve(code || 0);
        });

        proc.on('error', (err) => {
          if (options.signal) {
            options.signal.removeEventListener('abort', abortHandler);
          }
          reject(err);
        });
      });

      let usage: TokenUsage;
      let transcriptPath: string | undefined;
      if (monitorPromise) {
        usage = await monitorPromise;
      } else {
        transcriptPath = await findTranscriptFile(transcriptDir);
        usage = transcriptPath ? parseTranscriptTokens(transcriptPath) : { inputTokens: 0, outputTokens: 0 };
      }

      // A non-zero exit from a monitored run means monitorBudget sent SIGTERM —
      // return partial output rather than throwing.
      if (exitCode !== 0 && !monitorPromise) {
        throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr}`);
      }

      return {
        output: stdout,
        usage,
        durationMs: Date.now() - startTime,
        raw: { stdout, transcriptPath },
      };
    } finally {
      if (workDir) {
        cleanupWorkerDir(workDir);
      }
    }
  }
}
