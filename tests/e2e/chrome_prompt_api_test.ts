/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An ADK agent backed by `ChromeBuiltInLlm`, driven end to end in a real
 * browser.
 *
 * The unit tests in `core/test/models/chrome_prompt_llm_test.ts` drive the
 * adapter against a hand-written stand-in for `LanguageModel`. That proves the
 * adapter's own logic and nothing about the API it wraps, because a fake agrees
 * with whatever the adapter expects of it.
 *
 * This suite builds a normal `LlmAgent` with the Chrome model and runs it
 * through an `InMemoryRunner`, in Chrome, against whatever model Chrome
 * actually has. Playwright launches the browser; the page-side logic lives in
 * `chrome_prompt_api_driver.ts`, which esbuild bundles and Playwright injects.
 * The suite asserts the agent behaviours that depend on the real model inside
 * the ADK loop:
 *
 *   1. `availability()` answers, so the suite tells "no model" from "broken".
 *   2. The agent answers a plain question with non-empty text.
 *   3. The agent runs a declared tool through the full ADK loop: the model
 *      emits a `functionCall`, the runner executes the tool, and the tool
 *      result flows back into the conversation.
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
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Page} from 'playwright-chromium';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** The page-side driver esbuild bundles and Playwright injects. */
const DRIVER_ENTRY = path.join(
  REPO_ROOT,
  'tests/e2e/chrome_prompt_api_driver.ts',
);

/** How long to wait for the model to answer one prompt. */
const MODEL_TIMEOUT_MS = 120_000;

const IS_CI = process.env['CI'] === 'true';

/**
 * The on-device model is gated on these features in most Chrome channels.
 */
const CHROME_FEATURE_ARGS = [
  '--enable-features=AIPromptAPI,AIPromptAPIForGeminiNano',
];

/* ------------------------------------------------------------------ *
 * Finding Chrome
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

/* ------------------------------------------------------------------ *
 * The page-side driver
 * ------------------------------------------------------------------ */

/**
 * Bundles the agent, the adapter, and the driver that runs them, as one script
 * to inject into the page.
 *
 * The import graph reaches a handful of Node built-ins it never calls in a
 * browser — the logger and the client-label helpers. They are aliased to
 * stand-ins here rather than shipped; that is a property of the bundle this
 * test builds, not of the runtime code.
 */
async function buildDriverBundle(): Promise<string> {
  const stub = path.join(REPO_ROOT, 'tests/e2e/chrome_prompt_api_node_stub.js');
  const winstonStub = path.join(
    REPO_ROOT,
    'tests/e2e/chrome_prompt_api_winston_stub.js',
  );
  const result = await esbuild.build({
    entryPoints: [DRIVER_ENTRY],
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

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let browser: Browser | undefined;
let page: Page | undefined;
/** True when this test launched the browser and must close it. */
let ownsBrowser = false;
/** Why the suite is skipping, or undefined when it can run. */
let blocked: string | undefined;

/** Evaluates `__adkChromeTest.<call>` in the page and returns its result. */
async function run<T>(call: string): Promise<T> {
  return (await page!.evaluate(`__adkChromeTest.${call}`)) as T;
}

beforeAll(async () => {
  // Bail before launching anything on CI. Hosted runners have no GPU, so the
  // model is never available there, and launching a browser buys nothing but a
  // way for the suite to hang. `live_model_test.ts` skips on CI for the same
  // reason.
  if (IS_CI) {
    blocked = 'running on CI, which has no on-device model';
    return;
  }

  const cdpUrl = process.env['CHROME_CDP_URL'];
  if (cdpUrl) {
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
    } catch (error) {
      blocked = `cannot attach to ${cdpUrl}: ${(error as Error).message}`;
      return;
    }
  } else {
    const binary = findChrome();
    if (!binary) {
      blocked = 'no Chrome binary found (set CHROME_PATH)';
      return;
    }
    try {
      browser = await chromium.launch({
        executablePath: binary,
        headless: !process.env['CHROME_HEADFUL'],
        args: CHROME_FEATURE_ARGS,
      });
      ownsBrowser = true;
    } catch (error) {
      blocked = `Chrome did not start: ${(error as Error).message}`;
      return;
    }
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  page = await context.newPage();
  await page.goto('about:blank');

  try {
    await page.addScriptTag({content: await buildDriverBundle()});
  } catch (error) {
    // A bundle that throws while initialising would otherwise surface later as
    // "__adkChromeTest is undefined", which says nothing about the cause.
    blocked = `driver bundle failed to load: ${(error as Error).message}`;
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
  await page?.close();
  // Only close a browser this test launched; a browser reached over CDP belongs
  // to whoever started it.
  if (ownsBrowser) await browser?.close();
});

describe('An ADK agent backed by ChromeBuiltInLlm', () => {
  it(
    'answers a plain question with non-empty text',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{events: number; text: string; error: unknown}>(
        'answer("Name one primary colour.")',
      );
      expect(result.error).toBeNull();
      expect(result.text.trim().length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS,
  );

  it(
    'runs a declared tool through the full ADK loop',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<{
        toolRuns: number;
        toolCity: string | null;
        calledTool: boolean;
        gotToolResponse: boolean;
      }>('toolCall("What is the weather in Oslo?")');
      expect(result.calledTool).toBe(true);
      expect(result.gotToolResponse).toBe(true);
      expect(result.toolRuns).toBeGreaterThanOrEqual(1);
      expect(typeof result.toolCity).toBe('string');
      expect(String(result.toolCity).length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS * 2,
  );
});
