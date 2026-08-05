/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Static guards on `core/dist/web`.
 *
 * Whether the bundle actually works is covered by web_app_test.ts, which loads
 * it in a browser. These checks catch the two defects that shipped in the
 * emitted files themselves: a Node `createRequire` banner in every file, and a
 * `models/apigee_llm.js` that did not parse.
 */

const WEB_DIST = path.join(process.cwd(), 'core', 'dist', 'web');

async function collectJsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
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
  it('emits the file named by the package browser field', async () => {
    const pkg = JSON.parse(
      await fs.readFile(
        path.join(process.cwd(), 'core', 'package.json'),
        'utf8',
      ),
    ) as {browser?: string};
    expect(pkg.browser).toBeDefined();

    const target = path.join(process.cwd(), 'core', pkg.browser!);
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('contains no Node-only createRequire banner', async () => {
    const offenders: string[] = [];
    for (const file of await collectJsFiles(WEB_DIST)) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        offenders.push(path.relative(WEB_DIST, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('emits only parseable JavaScript', async () => {
    const unparseable: string[] = [];
    for (const file of await collectJsFiles(WEB_DIST)) {
      const source = await fs.readFile(file, 'utf8');
      try {
        await esbuild.transform(source, {loader: 'js', format: 'esm'});
      } catch {
        unparseable.push(path.relative(WEB_DIST, file));
      }
    }
    expect(unparseable).toEqual([]);
  });
});
