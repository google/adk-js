/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `human_input/payload_and_schema` — https://adk.dev/graphs/
 *
 * Calls no model, so it runs with the record/replay model on an empty response
 * set: a stray model call throws instead of reaching the network.
 */

import {describe, it} from 'vitest';
import {runOffline} from '../_shared.js';

describe('docs sample: human_input/payload_and_schema', () => {
  it('runs end to end without a model', async () => {
    await runOffline(
      'human_input/payload_and_schema',
      ['Paris', 'the museum'],
      {pausesOnFirstTurn: true},
    );
  });
});
