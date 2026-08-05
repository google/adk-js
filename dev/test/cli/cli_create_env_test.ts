/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the `.env` that `adk create` generates.
 *
 * The scaffolder used to write the key to `GOOGLE_API_KEY`, which only Vertex
 * AI Express Mode reads, so every generated project died at its first model
 * call. Asserting on the string written to `.env` cannot catch that — the
 * string was self-consistent, it just was not a name the runtime reads. So
 * this test loads the generated `.env` and nothing else, then checks the key
 * reaches the Gemini endpoint.
 */

import {Gemini} from '@google/adk';
import dotenv from 'dotenv';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

const MODEL = 'gemini-2.5-flash';
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
  spawn: vi.fn(),
}));

describe('adk create: the generated .env is usable by the runtime', () => {
  beforeAll(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-create-env-'));
    process.chdir(workDir);
    ({createAgent} = await import('../../src/cli/cli_create.js'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(workDir, {recursive: true, force: true});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends the scaffolded key to the Gemini endpoint', async () => {
    await createAgent({
      agentName: 'my-agent',
      forceYes: true,
      model: MODEL,
      language: 'ts',
      apiKey: TEST_API_KEY,
      project: '',
      region: '',
    });

    const generatedEnv = dotenv.parse(
      await fs.readFile(path.join(workDir, 'my-agent', '.env'), 'utf-8'),
    );
    for (const name of CREDENTIAL_ENV_VARS) {
      vi.stubEnv(name, undefined);
    }
    for (const [name, value] of Object.entries(generatedEnv)) {
      vi.stubEnv(name, value);
    }

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
    const model = new Gemini({model: MODEL});
    await expect(
      (async () => {
        for await (const _ of model.generateContentAsync({
          model: MODEL,
          contents: [{role: 'user', parts: [{text: 'hello'}]}],
          config: {},
          liveConnectConfig: {},
          toolsDict: {},
        })) {
          // Drain; the stubbed 401 rejects before anything is yielded.
        }
      })(),
    ).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('generativelanguage.googleapis.com');
    expect(requests[0]!.apiKey).toBe(TEST_API_KEY);
  });
});
