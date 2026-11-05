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
import {createSkillAgent, SKILL_TEST_CASES} from './agent.js';

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('telemetry integration — skill', () => {
  for (const testCase of SKILL_TEST_CASES) {
    it(`records telemetry matching ${testCase.testId}.json`, async () => {
      await assertTelemetryGolden({
        scenarioDir: SCENARIO_DIR,
        testCase,
        run: async () => {
          await runWithInMemoryRunner(createSkillAgent(testCase));
        },
      });
    });
  }

  it('has no orphaned golden files on disk', async () => {
    await assertNoOrphanedGoldens(SCENARIO_DIR, SKILL_TEST_CASES);
  });
});
