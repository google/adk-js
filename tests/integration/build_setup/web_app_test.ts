/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import * as path from 'node:path';
import {chromium, type Browser, type Page} from 'playwright-chromium';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * Runs ADK in a real browser.
 *
 * The other build tests assert things about the emitted files; none of them
 * prove the bundle works once a browser loads it. A DOM reference, a
 * browser-only module-loading failure or a broken primitive would all pass
 * those checks and fail here.
 *
 * `web_app/index.html` loads `core/dist/web/index_web.js` directly, exactly as
 * an application would. Nothing is bundled for the test.
 */

const REPO_ROOT = process.cwd();
const APP_URL_PATH = '/tests/integration/build_setup/web_app/index.html';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Serves the repo so the page's relative import of dist/web resolves. */
function startServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const filePath = path.join(REPO_ROOT, path.normalize(urlPath));
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(filePath).then(
      (body) => {
        res.writeHead(200, {
          'content-type':
            CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        });
        res.end(body);
      },
      () => res.writeHead(404).end(),
    );
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

describe('ADK runs in a real browser', () => {
  let server: http.Server;
  let browser: Browser;
  let page: Page;
  let pageErrors: string[] = [];

  beforeAll(async () => {
    server = await startServer();
    browser = await chromium.launch();
    page = await browser.newPage();

    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    const {port} = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}${APP_URL_PATH}`);
    await page.waitForSelector('#status:has-text("ready")', {timeout: 30000});
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it('loads the shipped bundle without a module or runtime error', () => {
    expect(pageErrors).toEqual([]);
  });

  it('shows the user message and the agent reply after clicking send', async () => {
    await page.fill('#prompt', 'hello agent');
    await page.click('#send');

    await page.waitForSelector('li[data-author="agent"]', {timeout: 30000});

    const rendered = await page.$$eval('#messages li', (items) =>
      items.map((item) => ({
        author: item.getAttribute('data-author'),
        text: item.textContent,
      })),
    );

    expect(rendered).toEqual([
      {author: 'user', text: 'hello agent'},
      {author: 'agent', text: 'Hello from the agent'},
    ]);
  });

  it('runs a second turn on the same session', async () => {
    await page.fill('#prompt', 'again please');
    await page.click('#send');

    // Passed as a string so the browser-only globals never appear in Node scope.
    await page.waitForFunction(
      'document.querySelectorAll("#messages li").length === 4',
      undefined,
      {timeout: 30000},
    );

    const authors = await page.$$eval('#messages li', (items) =>
      items.map((item) => item.getAttribute('data-author')),
    );
    expect(authors).toEqual(['user', 'agent', 'user', 'agent']);
    expect(pageErrors).toEqual([]);
  });
});
