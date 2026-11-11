/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards two regressions that made `dist/web` unloadable outside Node while
 * every other test kept passing, because the rest of the suite imports `src`.
 *
 *  - **A Node builtin in the ESM banner.** `build.js` prepends a `createRequire`
 *    shim to ESM output so an ESM build can reach a CommonJS dependency. That is
 *    a Node concern, and it was applied to the browser build too — putting
 *    `import {createRequire} from 'module'` at the top of *every* file in
 *    `dist/web`, including leaf modules with no Node dependency at all. Any
 *    bundler targeting a browser, a worker or an edge runtime then failed to
 *    resolve `'module'`.
 *
 *  - **Output that does not parse.** The browser target included Safari 11,
 *    which predates async generators, so esbuild lowered them — and its lowering
 *    of `yield* super.method()` emits `__yieldStar(super.method())` in a scope
 *    where `super` is a syntax error. `models/apigee_llm.js` did not parse.
 *
 * Deliberately *not* asserted: that nothing in `dist/web` imports a Node
 * builtin. Several modules legitimately do — `artifacts/file_artifact_service`,
 * `code_executors/unsafe_local_code_executor`, `environment/local_environment`,
 * `skills/loader`, `a2a/*` — and they are only reached by importing them. The
 * banner was different in kind: it was on everything.
 *
 * Skipped when `dist/web` has not been built, so `npm run test:unit` on a clean
 * checkout does not fail for a missing artifact.
 */

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const WEB_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'web',
);

function jsFilesIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...jsFilesIn(full));
    } else if (extname(full) === '.js') {
      found.push(full);
    }
  }
  return found;
}

const built = existsSync(WEB_DIR);

describe.skipIf(!built)('the web build is loadable outside Node', () => {
  const files = built ? jsFilesIn(WEB_DIR) : [];
  const relative = (file: string) => file.slice(WEB_DIR.length + 1);

  it('produced output to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('carries no createRequire shim', () => {
    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').includes('createRequire'))
      .map(relative);

    expect(
      offenders,
      `dist/web files with the Node createRequire shim:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('emits JavaScript that parses', async () => {
    /**
     * Parsed with the bundler the build itself uses, rather than by importing:
     * these are ES modules with real dependencies, and the failure being
     * guarded is purely syntactic — which is what `super` outside a method is.
     */
    const esbuild = await import('esbuild');
    const unparseable: string[] = [];

    for (const file of files) {
      try {
        esbuild.transformSync(readFileSync(file, 'utf8'), {
          loader: 'js',
          format: 'esm',
        });
      } catch {
        unparseable.push(relative(file));
      }
    }

    expect(
      unparseable,
      `dist/web files that do not parse:\n${unparseable.join('\n')}`,
    ).toEqual([]);
  });
});
