/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `auth_api_key` sample (offline): a node declares an API-key
 * authConfig, so the workflow pauses to request a credential before running it.
 */

import {Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const isPaused = (events: Event[]): boolean =>
  events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);

describe('workflow sample: auth_api_key', () => {
  it('pauses to request a credential before the authenticated node runs', async () => {
    const perTurn = await runSample({
      name: 'auth_api_key',
      rootAgent,
      turns: ['What is the weather?'],
      offline: true,
    });
    const [turn1] = perTurn;

    // The workflow pauses on turn 1 requesting the API-key credential; the
    // authenticated node has not produced weather output yet.
    expect(isPaused(turn1)).toBe(true);
    expect(authors(turn1).has('summarize')).toBe(false);
  });
});
