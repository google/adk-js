/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * Static guards on the Node builds, `core/dist/esm` and `core/dist/cjs`.
 *
 * The browser build must not carry the `createRequire` banner and the Node ESM
 * build must, so removing it outright would trade one broken target for
 * another. This asserts the Node side of that pair; web_build_test.ts asserts
 * the browser side.
 */

const ESM_DIST = path.join(process.cwd(), 'core', 'dist', 'esm');
const CJS_DIST = path.join(process.cwd(), 'core', 'dist', 'cjs');

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

describe('node build output', () => {
  it('emits the createRequire banner for the ESM build', async () => {
    const withBanner: string[] = [];
    for (const file of await collectJsFiles(ESM_DIST)) {
      const source = await fs.readFile(file, 'utf8');
      if (source.includes('topLevelCreateRequire')) {
        withBanner.push(file);
      }
    }
    expect(withBanner.length).toBeGreaterThan(0);
  });

  it('marks the CJS build as commonjs', async () => {
    const pkg = JSON.parse(
      await fs.readFile(path.join(CJS_DIST, 'package.json'), 'utf8'),
    ) as {type?: string};
    expect(pkg.type).toBe('commonjs');
  });

  it('keeps winston in the Node builds', async () => {
    // The browser build swaps winston for a console transport because winston
    // needs os/fs/zlib/http. Node keeps it, so a custom winston transport
    // configured through setLogger() still works there.
    const esm = await fs.readFile(
      path.join(ESM_DIST, 'utils', 'logger.js'),
      'utf8',
    );
    expect(esm).toContain('winston');
  });
});
