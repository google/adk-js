/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Docs sample: `dynamic/human_input` — https://adk.dev/graphs/
 *
 * Calls no model, so it runs with the record/replay model on an empty response
 * set: a stray model call throws instead of reaching the network.
 */

import {describe, it} from 'vitest';
import {runOffline} from '../_shared.js';

describe('docs sample: dynamic/human_input', () => {
  it('runs end to end without a model', async () => {
    await runOffline('dynamic/human_input', ['please approve', 'yes'], {
      pausesOnFirstTurn: true,
    });
  });
});
