/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `auth_oauth` sample (offline): a node declares a GitHub OAuth2
 * authConfig, so the workflow pauses and asks the user to complete the consent
 * flow before running.
 *
 * Only turn 1 is covered. The resumed node calls `https://api.github.com` for
 * real, and the harness mocks the model only — it does not intercept HTTP — so
 * a turn-2 assertion would need a live token and a network round trip.
 */

import {Event, getFunctionCalls} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const isPaused = (events: Event[]): boolean =>
  events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);

describe('workflow sample: auth_oauth', () => {
  it('pauses for OAuth consent with a GitHub authorization URL', async () => {
    const perTurn = await runSample({
      name: 'auth_oauth',
      rootAgent,
      turns: ['list my repos'],
      offline: true,
    });
    const [turn1] = perTurn;

    expect(isPaused(turn1)).toBe(true);
    expect(authors(turn1).has('display_result')).toBe(false);

    const request = turn1
      .flatMap((e) => getFunctionCalls(e))
      .find((c) => c.name === 'adk_request_credential');
    expect(request).toBeDefined();

    const args = request?.args as {
      authConfig?: {exchangedAuthCredential?: {oauth2?: {authUri?: string}}};
    };
    const authUri = args?.authConfig?.exchangedAuthCredential?.oauth2?.authUri;
    expect(authUri).toBeDefined();
    expect(authUri!).toContain('https://github.com/login/oauth/authorize');
    expect(authUri!).toContain('response_type=code');
    const scope = new URL(authUri!).searchParams.get('scope');
    expect(scope?.split(' ').sort()).toEqual(['repo', 'user']);
  });
});
