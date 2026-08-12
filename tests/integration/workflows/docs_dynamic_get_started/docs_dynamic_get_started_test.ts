/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the docs sample `samples/workflows/dynamic/get_started` — https://adk.dev/graphs/dynamic/
 *
 * An orchestrator node driving a child through `ctx.runNode()`. It calls no
 * model, so it runs with the record/replay model on an empty response set: a
 * stray model call throws instead of reaching the network.
 */

import {describe, expect, it} from 'vitest';
import {allEvents, finalOutput, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

describe('docs sample: dynamic/get_started', () => {
  it('runs end to end without a model', async () => {
    const perTurn = await runSample({
      name: 'docs_dynamic_get_started',
      rootAgent,
      turns: ['hello world'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe('Hello World');
  });
});
