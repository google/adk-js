/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

/**
 * Guards the browser build output in core/dist/web.
 *
 * Two defects shipped in it because nothing checked the artifacts:
 *
 *  - every file carried a Node `createRequire` banner, so a browser bundler
 *    reported an unresolvable `module` import ~187 times;
 *  - `models/apigee_llm.js` did not parse at all, because the browser target
 *    downlevelled an async generator and emitted `super` inside a closure.
 *
 * Both were invisible to the existing suite, which runs against src.
 */

const WEB_DIST = path.join(process.cwd(), 'core', 'dist', 'web');
const NODE_ESM_DIST = path.join(process.cwd(), 'core', 'dist', 'esm');

/** Every .js file under `dir`. */
async function collectJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, {withFileTypes: true});
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out;
}

describe('web build output', () => {
  let webFiles: string[] = [];

  beforeAll(async () => {
    // Requires `npm run build`, which CI runs before the test step.
    await fs.access(WEB_DIST);
    webFiles = await collectJsFiles(WEB_DIST);
    expect(webFiles.length).toBeGreaterThan(0);
  });

  it('contains no Node-only createRequire banner', async () => {
    const offenders: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        offenders.push(path.relative(WEB_DIST, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still emits the createRequire banner for the Node ESM build', async () => {
    // Guards against fixing the browser build by removing the banner outright.
    const nodeFiles = await collectJsFiles(NODE_ESM_DIST);
    const withBanner = [];
    for (const file of nodeFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        withBanner.push(file);
      }
    }
    expect(withBanner.length).toBeGreaterThan(0);
  });

  it('emits only parseable JavaScript', async () => {
    const unparseable: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      try {
        await esbuild.transform(source, {loader: 'js', format: 'esm'});
      } catch {
        unparseable.push(path.relative(WEB_DIST, file));
      }
    }
    expect(unparseable).toEqual([]);
  });

  it('imports no Node builtin that has no browser equivalent', async () => {
    // Scoped to `module` for now. dist/web still reaches for winston and
    // node:async_hooks; widen this list as those are addressed.
    const forbidden = ["from 'module'", 'from "module"'];
    const offenders: string[] = [];
    for (const file of webFiles) {
      const source = await fs.readFile(file, 'utf8');
      if (forbidden.some((needle) => source.includes(needle))) {
        offenders.push(path.relative(WEB_DIST, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
