/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it} from 'vitest';

import {
  assertNoOrphanedGoldens,
  assertTelemetryGolden,
  EXPERIMENTAL_TELEMETRY_TEST_CASES,
  runWithInMemoryRunner,
} from '../telemetry_test_utils.js';
import {createMultiAgent} from './agent.js';

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('telemetry integration — multi_agent', () => {
  for (const testCase of EXPERIMENTAL_TELEMETRY_TEST_CASES) {
    it(`records telemetry matching ${testCase.testId}.json`, async () => {
      await assertTelemetryGolden({
        scenarioDir: SCENARIO_DIR,
        testCase,
        run: async () => {
          await runWithInMemoryRunner(createMultiAgent());
        },
      });
    });
  }

  it('has no orphaned golden files on disk', async () => {
    await assertNoOrphanedGoldens(
      SCENARIO_DIR,
      EXPERIMENTAL_TELEMETRY_TEST_CASES,
    );
  });
});
