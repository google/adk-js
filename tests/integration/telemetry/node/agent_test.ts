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
  NODE_APP_NAME,
  NODE_USER_ID,
  runWithInMemoryRunner,
  SEMCONV_TEST_CASES,
} from '../telemetry_test_utils.js';
import {createNodeWorkflow} from './agent.js';

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('telemetry integration — node', () => {
  for (const testCase of SEMCONV_TEST_CASES) {
    it(`records telemetry matching ${testCase.testId}.json`, async () => {
      await assertTelemetryGolden({
        scenarioDir: SCENARIO_DIR,
        testCase,
        run: async () => {
          await runWithInMemoryRunner(createNodeWorkflow(), {
            appName: NODE_APP_NAME,
            userId: NODE_USER_ID,
          });
        },
      });
    });
  }

  it('has no orphaned golden files on disk', async () => {
    await assertNoOrphanedGoldens(SCENARIO_DIR, SEMCONV_TEST_CASES);
  });
});
