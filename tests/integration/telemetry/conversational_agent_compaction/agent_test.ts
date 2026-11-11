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
  runWithInMemoryRunner,
} from '../telemetry_test_utils.js';
import {
  buildSeededCompactionHistory,
  COMPACTION_APP_NAME,
  COMPACTION_TEST_CASES,
  COMPACTION_USER_ID,
  createCompactionAgent,
} from './agent.js';

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('telemetry integration — conversational_agent_compaction', () => {
  for (const testCase of COMPACTION_TEST_CASES) {
    it(`records telemetry matching ${testCase.testId}.json`, async () => {
      await assertTelemetryGolden({
        scenarioDir: SCENARIO_DIR,
        testCase,
        run: async () => {
          await runWithInMemoryRunner(createCompactionAgent(testCase), {
            appName: COMPACTION_APP_NAME,
            userId: COMPACTION_USER_ID,
            seedEvents: buildSeededCompactionHistory(),
          });
        },
      });
    });
  }

  it('has no orphaned golden files on disk', async () => {
    await assertNoOrphanedGoldens(SCENARIO_DIR, COMPACTION_TEST_CASES);
  });
});
