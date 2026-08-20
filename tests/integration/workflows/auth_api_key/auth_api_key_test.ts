/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `auth_api_key` sample (offline): a node declares an API-key
 * authConfig, so the workflow pauses to request a credential before running it,
 * then resumes once the credential is supplied. Turns and expectations mirror
 * the Python golden `contributing/samples/workflows/auth_api_key/tests/go.json`.
 */

import {Event, getFunctionCalls} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {allEvents, authors, runSample} from '../_harness/sample_harness.js';
import {rootAgent} from './agent.js';

const isPaused = (events: Event[]): boolean =>
  events.some((e) => (e.longRunningToolIds?.length ?? 0) > 0);

/** The credential reply, keyed by the interrupt id (the credential key). */
const credential: Content = {
  role: 'user',
  parts: [
    {
      functionResponse: {
        id: 'weather_api_key',
        name: 'adk_request_credential',
        response: {result: '12345678'},
      },
    },
  ],
};

describe('workflow sample: auth_api_key', () => {
  it('pauses for a credential, then runs the node with it', async () => {
    const perTurn = await runSample({
      name: 'auth_api_key',
      rootAgent,
      turns: ['go', credential],
      offline: true,
    });
    const [turn1, turn2] = perTurn;

    expect(isPaused(turn1)).toBe(true);
    const request = turn1
      .flatMap((e) => getFunctionCalls(e))
      .find((c) => c.name === 'adk_request_credential');
    expect(request).toBeDefined();
    expect(authors(turn1).has('summarize')).toBe(false);

    const weather = allEvents([turn2]).find(
      (e) => e.author === 'fetch_weather' && e.output !== undefined,
    );
    expect(weather?.output).toEqual({
      city: 'San Francisco',
      temperature: '18C',
      condition: 'Sunny',
      api_key_used: '1234****',
    });

    const summary = allEvents([turn2])
      .filter((e) => e.author === 'summarize')
      .flatMap((e) => e.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('');
    expect(summary).toBe(
      'Weather for San Francisco: 18C, Sunny. (Authenticated with key: 1234****)',
    );
    expect(isPaused(turn2)).toBe(false);
  });
});
