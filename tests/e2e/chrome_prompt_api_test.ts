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
 * adapter in Node against a hand-written stand-in for `LanguageModel`. That
 * proves the adapter's own logic and nothing about the browser it is built for:
 * a Node-only import, a DOM assumption or a stream handled wrongly all pass
 * there and fail in a page.
 *
 * So this builds a normal `LlmAgent` on the Chrome model, runs it through an
 * `InMemoryRunner` inside Chrome, and asserts the agent behaviours that matter:
 * a plain question comes back as text, and a declared tool goes through the
 * whole ADK loop — the model emits a `functionCall`, the runner executes the
 * tool, and the result flows back into the conversation.
 *
 * It runs those same cases twice, against two different models:
 *
 *   1. **A scripted model, always.** Hosted CI has no GPU, so the real model is
 *      never there, and a suite that only ever skips cannot catch a regression.
 *      This tier installs a scripted `LanguageModel` behind the same global the
 *      adapter reads and runs in Playwright's bundled Chromium, so it runs on
 *      every PR. Everything is real except token generation —
 *      `build_setup/web_app_test.ts` fakes the model for the same reason.
 *
 *   2. **The real on-device model, when the machine has one.** Only Chrome's
 *      own constrained decoding can show whether the adapter's schema survives
 *      contact with it. That needs a GPU, so this tier skips on CI and names
 *      the precondition it was missing rather than passing quietly.
 *
 * Running the real-model tier locally:
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

/** How long to wait for the real model to answer one prompt. */
const MODEL_TIMEOUT_MS = 120_000;

/** The scripted model answers immediately; only the browser costs anything. */
const SCRIPTED_TIMEOUT_MS = 60_000;

const IS_CI = process.env['CI'] === 'true';

/** The on-device model is gated on these features in most Chrome channels. */
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

/** Opens a page with the driver bundle loaded, failing loudly if it throws. */
async function openDriverPage(browser: Browser): Promise<Page> {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto('about:blank');
  await page.addScriptTag({content: await buildDriverBundle()});
  if (pageErrors.length) {
    throw new Error(`driver bundle failed to load: ${pageErrors.join('; ')}`);
  }
  return page;
}

/** Evaluates `__adkChromeTest.<call>` in the page and returns its result. */
function run<T>(page: Page, call: string): Promise<T> {
  return page.evaluate(`__adkChromeTest.${call}`) as Promise<T>;
}

/** What `answer()` returns from the page. */
interface AnswerResult {
  events: number;
  text: string;
  error: string | null;
}

/** What `toolCall()` returns from the page. */
interface ToolCallResult {
  toolRuns: number;
  toolCity: string | null;
  calledTool: boolean;
  gotToolResponse: boolean;
}

/* ------------------------------------------------------------------ *
 * 1. A scripted model. Runs everywhere, including CI.
 * ------------------------------------------------------------------ */

describe('An ADK agent in a browser, on a scripted model', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    // Playwright's own Chromium, which CI installs. Deliberately gated on
    // nothing: if this cannot run, the suite should fail rather than skip.
    browser = await chromium.launch();
    page = await openDriverPage(browser);
    await run<void>(page, 'installScriptedModel()');
    expect(await run<string>(page, 'availability()')).toBe('available');
  }, 120_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it(
    'answers a plain question with non-empty text',
    async () => {
      const result = await run<AnswerResult>(
        page,
        'answer("Name one primary colour.")',
      );
      expect(result.error).toBeNull();
      expect(result.text).toContain('primary colour');
    },
    SCRIPTED_TIMEOUT_MS,
  );

  it(
    'runs a declared tool through the full ADK loop',
    async () => {
      const result = await run<ToolCallResult>(
        page,
        'toolCall("What is the weather in Oslo?")',
      );
      expect(result.calledTool).toBe(true);
      expect(result.gotToolResponse).toBe(true);
      expect(result.toolRuns).toBeGreaterThanOrEqual(1);
      // The scripted model names the city, so the arguments are checked end to
      // end rather than merely being present.
      expect(result.toolCity).toBe('Oslo');
    },
    SCRIPTED_TIMEOUT_MS,
  );
});

/* ------------------------------------------------------------------ *
 * 2. The real on-device model. Local only.
 * ------------------------------------------------------------------ */

describe('An ADK agent in a browser, on the real on-device model', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  /** True when this suite launched the browser and must close it. */
  let ownsBrowser = false;
  /** Why the suite is skipping, or undefined when it can run. */
  let blocked: string | undefined;

  beforeAll(async () => {
    // Bail before launching anything on CI. Hosted runners have no GPU, so the
    // model is never available there, and launching a second browser buys
    // nothing. `live_model_test.ts` skips on CI for the same reason.
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
      // The real model lives in an installed Chrome, not in Playwright's
      // bundled Chromium.
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

    try {
      page = await openDriverPage(browser);
    } catch (error) {
      blocked = (error as Error).message;
      return;
    }

    const state = await run<string>(page, 'availability()');
    if (state !== 'available') {
      blocked =
        state === 'missing-api'
          ? 'this Chrome does not expose the Prompt API'
          : `Chrome reports the on-device model as "${state}"`;
    }
  }, 180_000);

  afterAll(async () => {
    // A wholly skipped suite is otherwise silent about why, which reads the
    // same as a suite with nothing in it.
    if (blocked) {
      console.warn(`[chrome-prompt-api] real model skipped: ${blocked}`);
    }
    await page?.close();
    // Only close a browser this suite launched; one reached over CDP belongs to
    // whoever started it.
    if (ownsBrowser) await browser?.close();
  });

  it(
    'answers a plain question with non-empty text',
    async (ctx) => {
      if (blocked) return ctx.skip();
      const result = await run<AnswerResult>(
        page!,
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
      const result = await run<ToolCallResult>(
        page!,
        'toolCall("What is the weather in Oslo?")',
      );
      expect(result.calledTool).toBe(true);
      expect(result.gotToolResponse).toBe(true);
      expect(result.toolRuns).toBeGreaterThanOrEqual(1);
      expect(typeof result.toolCity).toBe('string');
      expect(String(result.toolCity).length).toBeGreaterThan(0);
    },
    MODEL_TIMEOUT_MS * 2,
  );
});
