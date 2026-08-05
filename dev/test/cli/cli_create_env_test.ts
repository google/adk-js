/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end regression test for the `adk create` scaffold.
 *
 * `adk create` used to write `GOOGLE_API_KEY` into the generated `.env`, a
 * variable only Vertex AI Express Mode reads. The same file also sets
 * `GOOGLE_GENAI_USE_VERTEXAI=0`, which selects the Gemini API path, so every
 * scaffolded project failed at its first model call with "API key must be
 * provided ..." no matter what key the user supplied.
 *
 * A test asserting on the literal string written to `.env` cannot catch that
 * class of bug: the string was internally consistent, it just was not a name
 * the runtime reads. So this test closes the loop instead — it scaffolds a
 * real project on disk, loads only the generated `.env`, builds the model the
 * generated agent asks for, and asserts the user's key reaches the wire.
 * Rename either side of the contract and this fails.
 */

import {Gemini, GoogleLLMVariant, type LlmRequest} from '@google/adk';
import dotenv from 'dotenv';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

/** The model the generated `agent.ts` defaults to. */
const SCAFFOLD_DEFAULT_MODEL = 'gemini-2.5-flash';

const TEST_API_KEY = 'test-api-key-from-adk-create';

/**
 * Every Google/Gemini credential variable the runtime might read, cleared so
 * an ambient value on the developer's machine cannot mask a broken `.env`.
 */
const CREDENTIAL_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENAI_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
];

// `cli_create` captures `process.cwd()` at module scope, so the working
// directory has to be set before it is imported.
let createAgent: typeof import('../../src/cli/cli_create.js').createAgent;
let workDir: string;
let originalCwd: string;

// `createAgent` shells out to `npm install` once the files are written. The
// files are what is under test, so stub the child process out; everything
// else — file writes, `.env` parsing, model construction — stays real.
vi.mock('node:child_process', () => ({
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      callback?: (e: null, stdout: string, stderr: string) => void,
    ) => {
      callback?.(null, '', '');
      return {on: (event: string, cb: () => void) => event === 'exit' && cb()};
    },
  ),
  execSync: vi.fn(() => ''),
}));

/** Scaffolds an agent and returns the parsed contents of its `.env`. */
async function scaffold(
  agentName: string,
  options: {apiKey?: string; project?: string; region?: string},
): Promise<Record<string, string>> {
  await createAgent({
    agentName,
    forceYes: true,
    model: SCAFFOLD_DEFAULT_MODEL,
    language: 'ts',
    apiKey: options.apiKey ?? '',
    project: options.project ?? '',
    region: options.region ?? '',
  });

  const envPath = path.join(workDir, agentName, '.env');
  return dotenv.parse(await fs.readFile(envPath, 'utf-8'));
}

/** Applies a parsed `.env` to `process.env`, and nothing else. */
function applyEnv(env: Record<string, string>): void {
  for (const name of CREDENTIAL_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
}

/** A minimal request for the model the scaffolded agent declares. */
function helloRequest(): LlmRequest {
  return {
    model: SCAFFOLD_DEFAULT_MODEL,
    contents: [{role: 'user', parts: [{text: 'hello'}]}],
    config: {},
    liveConnectConfig: {},
    toolsDict: {},
  };
}

describe('adk create: the generated .env is usable by the runtime', () => {
  beforeAll(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-create-e2e-'));
    process.chdir(workDir);
    ({createAgent} = await import('../../src/cli/cli_create.js'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(workDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('writes the key under a name the Gemini API path reads', async () => {
    const env = await scaffold('api-key-agent', {apiKey: TEST_API_KEY});

    // Not a spelling check for its own sake: these are the only two names
    // `geminiInitParams` falls back to when Vertex AI is off.
    expect(env['GOOGLE_GENAI_API_KEY'] ?? env['GEMINI_API_KEY']).toBe(
      TEST_API_KEY,
    );
    expect(env['GOOGLE_GENAI_USE_VERTEXAI']).toBe('0');
  });

  it('reaches the Gemini API with the scaffolded key', async () => {
    const env = await scaffold('reaches-model-agent', {apiKey: TEST_API_KEY});
    applyEnv(env);

    const requests: Array<{url: string; apiKey: string | null}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (...[input, init]: Parameters<typeof fetch>) => {
        requests.push({
          url: String(input),
          apiKey: new Headers(init?.headers).get('x-goog-api-key'),
        });
        // Stop at the network boundary; reaching it is the whole assertion.
        return new Response(
          JSON.stringify({error: {code: 401, message: 'stubbed'}}),
          {status: 401, headers: {'content-type': 'application/json'}},
        );
      },
    );

    // Threw "API key must be provided via constructor or GOOGLE_GENAI_API_KEY
    // or GEMINI_API_KEY environment variable." before the fix — no request was
    // ever made.
    const model = new Gemini({model: SCAFFOLD_DEFAULT_MODEL});
    await expect(
      (async () => {
        for await (const _ of model.generateContentAsync(helloRequest())) {
          // Drain; the stubbed 401 rejects before anything is yielded.
        }
      })(),
    ).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(requests[0]!.apiKey).toBe(TEST_API_KEY);
  });

  it('still scaffolds a working Vertex AI project from project and region', async () => {
    const env = await scaffold('vertex-agent', {
      project: 'my-project',
      region: 'us-central1',
    });
    applyEnv(env);

    const model = new Gemini({model: SCAFFOLD_DEFAULT_MODEL});

    expect(model.apiBackend).toBe(GoogleLLMVariant.VERTEX_AI);
  });
});
