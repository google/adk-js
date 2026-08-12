/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Guards the suite itself: a sample added under `samples/workflows/` has to
 * gain a test directory here, rather than silently shipping with no coverage.
 *
 * Comparing directory listings rather than a checked-in list means the guard
 * cannot drift out of date with the tests it guards.
 */

import {readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = path.resolve(HERE, '../../../samples/workflows');

/** Every `<category>/<name>` sample on disk, as a `<category>_<name>` id. */
function sampleDirNames(): string[] {
  const found: string[] = [];
  for (const category of readdirSync(SAMPLES_ROOT)) {
    const categoryPath = path.join(SAMPLES_ROOT, category);
    if (!statSync(categoryPath).isDirectory()) continue;
    for (const name of readdirSync(categoryPath)) {
      const agent = path.join(categoryPath, name, 'agent.ts');
      if (statSync(agent, {throwIfNoEntry: false})?.isFile()) {
        found.push(`${category}_${name}`);
      }
    }
  }
  return found.sort();
}

/** Every directory here holding a matching `<dir>_test.ts`. */
function testDirNames(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(HERE)) {
    const dir = path.join(HERE, entry);
    if (!statSync(dir).isDirectory()) continue;
    const test = path.join(dir, `${entry}_test.ts`);
    if (statSync(test, {throwIfNoEntry: false})?.isFile()) {
      found.push(entry);
    }
  }
  return found.sort();
}

describe('workflow docs samples', () => {
  it('has a test directory for every sample on disk', () => {
    expect(testDirNames()).toEqual(sampleDirNames());
  });
});
