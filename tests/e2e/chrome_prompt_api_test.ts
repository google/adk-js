/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ChromePromptApiLlm` against the real on-device model, in a real browser.
 *
 * The unit tests in `core/test/models/chrome_prompt_llm_test.ts` drive the
 * adapter against a hand-written stand-in for `LanguageModel`. That proves the
 * adapter's own logic and nothing about the API it wraps, because a fake agrees
 * with whatever the adapter expects of it. The interesting failures are the
 * ones where the browser disagrees: constrained decoding that emits a key the
 * schema did not declare, a session `clone()` that does not carry the system
 * prompt, a stream that ends mid-token.
 *
 * So this runs the same adapter in Chrome, against whatever model Chrome
 * actually has, and asserts the behaviours the adapter depends on:
 *
 *   1. `availability()` answers, and the adapter reports an unusable model as
 *      an error response rather than throwing.
 *   2. A plain question comes back as non-empty text on an `LlmResponse`.
 *   3. Streaming yields more than one partial before the final response.
 *   4. A declared tool comes back as a real `functionCall` part whose args
 *      match the declared schema — the constrained-decoding path.
 *   5. The warm base session is created once and cloned per turn.
 *
 * Preconditions, and what happens without them:
 *
 *   - No Chrome binary          -> the suite skips.
 *   - Chrome has no usable model -> the suite skips, naming the availability.
 *
 * CI machines have no GPU, so Chrome reports `unavailable` there and every case
 * skips. That is the intended behaviour: this test is a local gate, and the
 * unit tests remain the CI gate.
 *
 * Running it:
 *
 *   npx vitest --project e2e chrome_prompt_api
 *
 * If the model reports unavailable under headless Chrome but works in your
 * normal browser, run it headful, or point it at a browser you already have
 * open with remote debugging on:
 *
 *   CHROME_HEADFUL=1 npx vitest --project e2e chrome_prompt_api
 *   CHROME_CDP_URL=http://127.0.0.1:9222 npx vitest --project e2e chrome_prompt_api
 *
 * `CHROME_PATH` overrides binary discovery.
 */

import * as esbuild from 'esbuild';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** How long to wait for the model to answer one prompt. */
const MODEL_TIMEOUT_MS = 120_000;

const IS_CI = process.env['CI'] === 'true';

/* ------------------------------------------------------------------ *
 * Finding and launching Chrome
 * ------------------------------------------------------------------ */

function findChrome(): string | undefined {
  if (process.env['CHROME_PATH']) return process.env['CHROME_PATH'];
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/opt/google/chrome/chrome',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
          ];
  return candidates.find(existsSync);
}

/** The fields of a CDP response this test reads. */
interface CdpResult {
  result?: {value?: unknown};
  exceptionDetails?: {text?: string; exception?: {description?: string}};
  [key: string]: unknown;
}

/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Only what this test needs: open a page, evaluate an expression in it, read
 * the result. Written against the global `WebSocket` so the test adds no
 * dependency to the repo for a suite that usually skips.
 */
class Cdp {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {resolve: (v: CdpResult) => void; reject: (e: Error) => void}
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String((event as MessageEvent).data)) as {
        id?: number;
        result?: CdpResult;
        error?: {message: string};
      };
      if (msg.id === undefined) return;
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result ?? {});
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), {once: true});
      socket.addEventListener(
        'error',
        () => reject(new Error(`cannot open ${url}`)),
        {once: true},
      );
    });
    return new Cdp(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<CdpResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.socket.send(JSON.stringify({id, method, params}));
    });
  }

  close() {
    this.socket.close();
  }
}

/**
 * Finds a page target's own websocket, given the browser-level one.
 *
 * Both live on the same port, and `/json/list` names the page targets.
 */
async function findPageTarget(
  browserWsUrl: string,
): Promise<string | undefined> {
  const {port} = new URL(browserWsUrl.replace(/^ws:/, 'http:'));
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
    r.json(),
  )) as Array<{type: string; webSocketDebuggerUrl?: string}>;
  return targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    ?.webSocketDebuggerUrl;
}

/** Reads the DevTools websocket URL Chrome prints on stderr as it starts. */
function waitForDevtoolsUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Chrome did not report a DevTools endpoint')),
      30_000,
    );
    let buffered = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = buffered.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (code ${code})`));
    });
  });
}

/* ------------------------------------------------------------------ *
 * The page-side driver
 * ------------------------------------------------------------------ */

/**
 * Bundles the adapter together with a driver that exercises it, as one script
 * to evaluate in the page.
 *
 * The adapter's import graph reaches a handful of Node built-ins it never calls
 * in a browser — the logger and the client-label helpers. They are aliased to
 * stand-ins here rather than shipped; that is a property of the bundle this
 * test builds, not of the adapter.
 */
async function buildDriverBundle(): Promise<string> {
  const stub = path.join(REPO_ROOT, 'tests/e2e/chrome_prompt_api_node_stub.js');
  const winstonStub = path.join(
    REPO_ROOT,
    'tests/e2e/chrome_prompt_api_winston_stub.js',
  );
  const result = await esbuild.build({
    stdin: {
      contents: DRIVER_SOURCE,
      resolveDir: path.join(REPO_ROOT, 'core/src/models'),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__adkChromeTest',
    platform: 'browser',
    target: 'chrome138',
    write: false,
    logLevel: 'silent',
    alias: {
      http: stub,
      https: stub,
      os: stub,
      util: stub,
      winston: winstonStub,
      'node:async_hooks': stub,
      'node:crypto': stub,
    },
  });
  return result.outputFiles[0].text;
}

/**
 * Runs in the page. Returns a plain object so it survives the CDP boundary.
 *
 * Kept as a string rather than a real module so esbuild bundles it with the
 * adapter in one pass and nothing has to be served over http.
 */
const DRIVER_SOURCE = `
import {ChromePromptApiLlm} from './chrome_prompt_llm.js';

const textOf = (response) =>
  (response?.content?.parts ?? []).map((p) => p.text ?? '').join('');

export async function availability() {
  if (typeof globalThis.LanguageModel === 'undefined') return 'missing-api';
  return await globalThis.LanguageModel.availability();
}

/** One non-streaming turn. */
export async function answer(question) {
  const llm = new ChromePromptApiLlm({});
  const responses = [];
  for await (const r of llm.generateContentAsync(
    {
      model: 'chrome-on-device',
      contents: [{role: 'user', parts: [{text: question}]}],
      config: {systemInstruction: 'Answer in one short sentence.'},
    },
    false,
  )) {
    responses.push({text: textOf(r), error: r.errorCode ?? null});
  }
  const last = responses[responses.length - 1];
  return {count: responses.length, text: last?.text ?? '', error: last?.error ?? null};
}

/** One streaming turn, counting partials. */
export async function stream(question) {
  const llm = new ChromePromptApiLlm({});
  let partials = 0;
  let finalText = '';
  for await (const r of llm.generateContentAsync(
    {
      model: 'chrome-on-device',
      contents: [{role: 'user', parts: [{text: question}]}],
      config: {systemInstruction: 'Answer in one short sentence.'},
    },
    true,
  )) {
    if (r.partial) partials++;
    else finalText = textOf(r);
  }
  return {partials, finalText};
}

/** One turn with a tool declared, exercising constrained decoding. */
export async function toolCall(question) {
  const llm = new ChromePromptApiLlm({});
  const parts = [];
  for await (const r of llm.generateContentAsync(
    {
      model: 'chrome-on-device',
      contents: [{role: 'user', parts: [{text: question}]}],
      config: {
        systemInstruction:
          'You look up weather. Call get_weather for any question about weather.',
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                description: 'Returns the current weather for a city.',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {city: {type: 'string'}},
                  required: ['city'],
                },
              },
            ],
          },
        ],
      },
    },
    false,
  )) {
    for (const p of r.content?.parts ?? []) parts.push(p);
  }
  const call = parts.find((p) => p.functionCall)?.functionCall;
  return {
    called: call?.name ?? null,
    args: call?.args ?? null,
    text: parts.map((p) => p.text ?? '').join(''),
  };
}

/** Two turns on one adapter, counting create() against clone(). */
export async function sessionReuse() {
  let creates = 0;
  let clones = 0;
  const real = globalThis.LanguageModel;
  const counting = {
    availability: (...a) => real.availability(...a),
    create: async (...a) => {
      creates++;
      const session = await real.create(...a);
      const wrap = (s) => ({
        prompt: (...p) => s.prompt(...p),
        promptStreaming: (...p) => s.promptStreaming(...p),
        clone: async (...p) => {
          clones++;
          return wrap(await s.clone(...p));
        },
        destroy: () => s.destroy?.(),
        get inputUsage() { return s.inputUsage; },
        get inputQuota() { return s.inputQuota; },
      });
      return wrap(session);
    },
  };
  const llm = new ChromePromptApiLlm({languageModel: counting});
  for (const q of ['Say hello.', 'Say goodbye.']) {
    for await (const _ of llm.generateContentAsync(
      {
        model: 'chrome-on-device',
        contents: [{role: 'user', parts: [{text: q}]}],
        config: {systemInstruction: 'Answer in one short sentence.'},
      },
      false,
    )) {
      // drain
    }
  }
  return {creates, clones};
}
`;

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let chrome: ChildProcess | undefined;
let cdp: Cdp | undefined;
let profileDir: string | undefined;
/** Why the suite is skipping, or undefined when it can run. */
let blocked: string | undefined;

/** Evaluates `__adkChromeTest.<call>` in the page and returns its result. */
async function run<T>(call: string): Promise<T> {
  const result = await cdp!.send('Runtime.evaluate', {
    expression: `__adkChromeTest.${call}`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result?.value as T;
}

beforeAll(async () => {
  // Bail before spawning anything on CI. Hosted runners have no GPU, so the
  // model is never available there, and launching a browser buys nothing but a
  // way for the suite to hang. `live_model_test.ts` skips on CI for the same
  // reason.
  if (IS_CI) {
    blocked = 'running on CI, which has no on-device model';
    return;
  }

  const existing = process.env['CHROME_CDP_URL'];
  let wsUrl: string;

  if (existing) {
    const listing = await fetch(new URL('/json/version', existing)).then((r) =>
      r.json(),
    );
    wsUrl = listing.webSocketDebuggerUrl;
  } else {
    const binary = findChrome();
    if (!binary) {
      blocked = 'no Chrome binary found (set CHROME_PATH)';
      return;
    }
    profileDir = mkdtempSync(path.join(tmpdir(), 'adk-chrome-'));
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The on-device model is gated on these in most channels.
      '--enable-features=AIPromptAPI,AIPromptAPIForGeminiNano',
      'about:blank',
    ];
    if (!process.env['CHROME_HEADFUL']) args.unshift('--headless=new');
    chrome = spawn(binary, args, {stdio: ['ignore', 'ignore', 'pipe']});
    try {
      wsUrl = await waitForDevtoolsUrl(chrome);
    } catch (error) {
      blocked = `Chrome did not start: ${(error as Error).message}`;
      return;
    }
  }

  // Connect to the page target directly rather than the browser endpoint.
  // The browser endpoint has no Runtime domain, and attaching to a target
  // would mean routing every later message through a session id; the page's
  // own websocket needs neither.
  const pageWsUrl = await findPageTarget(wsUrl);
  if (!pageWsUrl) {
    blocked = 'Chrome exposed no page target';
    return;
  }
  cdp = await Cdp.connect(pageWsUrl);

  await cdp.send('Runtime.enable');
  const injected = await cdp.send('Runtime.evaluate', {
    expression: await buildDriverBundle(),
    returnByValue: false,
  });
  if (injected.exceptionDetails) {
    // A bundle that throws while initialising would otherwise surface later as
    // "__adkChromeTest is undefined", which says nothing about the cause.
    blocked = `driver bundle failed to load: ${
      injected.exceptionDetails.exception?.description ??
      injected.exceptionDetails.text
    }`;
    return;
  }

  const state = await run<string>('availability()');
  if (state !== 'available') {
    blocked =
      state === 'missing-api'
        ? 'this Chrome does not expose the Prompt API'
        : `Chrome reports the on-device model as "${state}"`;
  }
}, 180_000);

afterAll(() => {
  // A wholly skipped file is otherwise silent about why, which reads the same
  // as a file with nothing in it.
  if (blocked) console.warn(`[chrome-prompt-api] skipped: ${blocked}`);
});

afterAll(async () => {
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    // Wait for the process to actually go before removing its profile, or the
    // directory is still being written to and rmSync fails with ENOTEMPTY.
    const exited = new Promise<void>((resolve) =>
      chrome!.once('exit', () => resolve()),
    );
    chrome.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (profileDir) rmSync(profileDir, {recursive: true, force: true});
});

describe('ChromePromptApiLlm against the real on-device model', () => {
  it(
    'answers a plain question with non-empty text',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{count: number; text: string; error: unknown}>(
        'answer("Name one primary colour.")',
      );
      expect(result.error).toBeNull();
      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS,
  );

  it(
    'streams more than one partial before the final response',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{partials: number; finalText: string}>(
        'stream("Count from one to five.")',
      );
      expect(result.partials).toBeGreaterThan(1);
      expect(result.finalText.trim().length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS,
  );

  it(
    'produces a functionCall whose args match the declared schema',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{
        called: string | null;
        args: Record<string, unknown> | null;
      }>('toolCall("What is the weather in Oslo?")');
      expect(result.called).toBe('get_weather');
      expect(typeof result.args?.['city']).toBe('string');
      expect(String(result.args?.['city']).length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS,
  );

  it(
    'creates the base session once and clones it per turn',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{creates: number; clones: number}>(
        'sessionReuse()',
      );
      expect(result.creates).toBe(1);
      expect(result.clones).toBe(2);
    },
    MODEL_TIMEOUT_MS * 2,
  );
});
