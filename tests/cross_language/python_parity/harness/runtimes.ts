/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives both `adk run` CLIs over the same replay file.
 *
 * Both accept `--replay <json>` with `{state, queries}` and both can dump the
 * resulting session with `--save_session`, so the comparison reads structured
 * events rather than scraped stdout.
 */

import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildTrace} from './normalize.ts';
import type {ParityCase, Runtime, Trace} from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(ROOT, '../../..');

export const PY_ADK = path.join(ROOT, '.venv/bin/adk');
export const PY_AGENTS = path.join(ROOT, 'agents/py');
export const TS_CLI = path.join(REPO_ROOT, 'dev/dist/esm/cli_entrypoint.js');
export const TS_AGENTS = path.join(ROOT, 'agents/ts');
export const RUNS = path.join(ROOT, 'runs');

export const PARITY_MODEL =
  process.env['ADK_PARITY_MODEL'] ?? 'gemini-2.5-flash';

/** Milliseconds before a single `adk run` is killed. */
const RUN_TIMEOUT_MS = Number(process.env['ADK_PARITY_TIMEOUT_MS'] ?? 300_000);

/** True when both runtimes are installed and a Gemini backend is reachable. */
export function harnessIsProvisioned(): {ok: boolean; reason?: string} {
  if (!fs.existsSync(PY_ADK)) {
    return {ok: false, reason: `missing ${PY_ADK} — run setup.sh`};
  }
  if (!fs.existsSync(TS_CLI)) {
    return {ok: false, reason: `missing ${TS_CLI} — run npm run build`};
  }
  const hasVertex = !!process.env['GOOGLE_CLOUD_PROJECT'];
  const hasApiKey =
    !!process.env['GOOGLE_API_KEY'] || !!process.env['GEMINI_API_KEY'];
  if (!hasVertex && !hasApiKey) {
    return {
      ok: false,
      reason: 'no GOOGLE_CLOUD_PROJECT and no GOOGLE_API_KEY/GEMINI_API_KEY',
    };
  }
  return {ok: true};
}

/**
 * The environment both runs share.
 *
 * `GOOGLE_API_CERTIFICATE_CONFIG` is stripped deliberately: when it is set the
 * genai clients switch to the mTLS endpoint (`aiplatform.mtls.googleapis.com`)
 * and every request fails with a transport error on a machine that has the
 * config but not the client cert.
 */
function runEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {...process.env};
  delete env['GOOGLE_API_CERTIFICATE_CONFIG'];
  env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'false';
  env['ADK_PARITY_MODEL'] = PARITY_MODEL;

  if (process.env['GOOGLE_API_KEY'] || process.env['GEMINI_API_KEY']) {
    return env;
  }
  env['GOOGLE_GENAI_USE_VERTEXAI'] = '1';
  env['GOOGLE_CLOUD_LOCATION'] =
    process.env['GOOGLE_CLOUD_LOCATION'] ?? 'global';
  return env;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function runCli(
  command: string,
  args: string[],
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: runEnv(),
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + String(err),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

/** Writes the `{state, queries}` file both CLIs consume. */
export function writeReplayFile(parityCase: ParityCase, dir: string): string {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'replay.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {state: parityCase.state ?? {}, queries: parityCase.queries},
      null,
      2,
    ),
  );
  return file;
}

/**
 * Both CLIs write `<sessionId>.session.json` next to the agent. Move it into
 * the run directory so a failed run leaves nothing behind in the agent tree.
 */
function collectSession(
  savedAt: string,
  destination: string,
): Record<string, unknown> | undefined {
  if (!fs.existsSync(savedAt)) {
    return undefined;
  }
  fs.renameSync(savedAt, destination);
  try {
    return JSON.parse(fs.readFileSync(destination, 'utf8'));
  } catch {
    return undefined;
  }
}

function toTrace(
  runtime: Runtime,
  result: SpawnResult,
  session: Record<string, unknown> | undefined,
): Trace {
  let failure: string | undefined;
  if (result.timedOut) {
    failure = `timed out after ${RUN_TIMEOUT_MS}ms`;
  } else if (session === undefined) {
    failure =
      result.exitCode !== 0
        ? `exit ${result.exitCode}: ${lastMeaningfulLine(result.stderr || result.stdout)}`
        : 'no session file was written';
  }

  return buildTrace({
    runtime,
    session,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    failure,
  });
}

/**
 * Strips ANSI colour codes. The TS CLI colourises its error output, and those
 * escapes would otherwise end up in diff.json and in the Markdown report.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** The last line that looks like an error, for a one-line failure summary. */
function lastMeaningfulLine(text: string): string {
  const lines = stripAnsi(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith('warnings.warn') && !l.includes('UserWarning'),
    );
  return lines.at(-1) ?? '(no output)';
}

/** Runs the Python side of a case. */
export async function runPython(
  parityCase: ParityCase,
  runDir: string,
  replayFile: string,
): Promise<Trace> {
  const sessionId = `parity_py_${parityCase.id}`;
  const agentDir = path.join(PY_AGENTS, parityCase.id);
  const result = await runCli(
    PY_ADK,
    [
      'run',
      path.relative(ROOT, agentDir),
      '--replay',
      path.relative(ROOT, replayFile),
      '--save_session',
      '--session_id',
      sessionId,
    ],
    ROOT,
  );

  const session = collectSession(
    path.join(agentDir, `${sessionId}.session.json`),
    path.join(runDir, 'python.session.json'),
  );
  const trace = toTrace('python', result, session);
  fs.writeFileSync(path.join(runDir, 'python.stdout.txt'), result.stdout);
  fs.writeFileSync(path.join(runDir, 'python.stderr.txt'), result.stderr);
  return trace;
}

/** Runs the TypeScript side of a case. */
export async function runTypeScript(
  parityCase: ParityCase,
  runDir: string,
  replayFile: string,
): Promise<Trace> {
  const sessionId = `parity_ts_${parityCase.id}`;
  const agentFile = path.join(TS_AGENTS, `${parityCase.tsAgent}.ts`);
  const result = await runCli(
    process.execPath,
    [
      TS_CLI,
      'run',
      path.relative(ROOT, agentFile),
      '--replay',
      path.relative(ROOT, replayFile),
      '--save_session',
      'true',
      '--session_id',
      sessionId,
    ],
    ROOT,
  );

  const session = collectSession(
    path.join(path.dirname(agentFile), `${sessionId}.session.json`),
    path.join(runDir, 'ts.session.json'),
  );
  const trace = toTrace('ts', result, session);
  fs.writeFileSync(path.join(runDir, 'ts.stdout.txt'), result.stdout);
  fs.writeFileSync(path.join(runDir, 'ts.stderr.txt'), result.stderr);
  return trace;
}
