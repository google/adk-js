/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {TelemetryDigest} from './functional/digests.js';
import {FunctionalTestCase, recordScenario} from './functional/recording.js';
import {ALL_FUNCTIONAL_TEST_CASES} from './functional/scenarios/testcasedata.js';
import {executeScenario} from './functional/scenarios/testcaseimpl.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLDENS_DIR = path.join(CURRENT_DIR, 'goldens');

function getGoldenPath(tc: FunctionalTestCase): string {
  return path.join(GOLDENS_DIR, tc.scenario, `${tc.testId}.json`);
}

async function listJsonFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFilesRecursively(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

describe('functional telemetry goldens', () => {
  for (const tc of ALL_FUNCTIONAL_TEST_CASES) {
    it(`${tc.scenario}/${tc.testId}`, async () => {
      const digest = await recordScenario(tc, executeScenario);
      const goldenPath = getGoldenPath(tc);

      if (process.env.ADK_UPDATE_TELEMETRY_GOLDENS === '1') {
        await fs.mkdir(path.dirname(goldenPath), {recursive: true});
        await fs.writeFile(
          goldenPath,
          `${JSON.stringify(digest, null, 2)}\n`,
          'utf8',
        );
      }

      const rawGolden = await fs.readFile(goldenPath, 'utf8');
      const expected = JSON.parse(rawGolden) as TelemetryDigest;
      expect(digest).toEqual(expected);
    });
  }

  it('has no orphaned golden files on disk', async () => {
    const actualFiles = await listJsonFilesRecursively(GOLDENS_DIR);
    const expectedFiles = ALL_FUNCTIONAL_TEST_CASES.map((tc) =>
      getGoldenPath(tc),
    ).sort();
    expect(actualFiles).toEqual(expectedFiles);
  });
});
