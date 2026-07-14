/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  generateClientFunctionCallId,
  populateClientFunctionCallId,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('populateClientFunctionCallId End-to-End Manual Test', () => {
  it('should populate client function call IDs without mocks when calls lack an ID', () => {
    // Act as a manual e2e test with real event creation and real UUID generation via @google/adk
    const event: Event = createEvent({
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'get_weather', args: {location: 'Seattle'}}},
          {
            functionCall: {
              name: 'get_time',
              args: {timezone: 'America/Los_Angeles'},
            },
          },
        ],
      },
    });

    // Verify initial state has no IDs assigned
    expect(event.content!.parts![0].functionCall!.id).toBeUndefined();
    expect(event.content!.parts![1].functionCall!.id).toBeUndefined();

    // Execute populateClientFunctionCallId using the real public API
    populateClientFunctionCallId(event);

    // Verify both function calls now have unique client IDs starting with adk-
    const id1 = event.content!.parts![0].functionCall!.id;
    const id2 = event.content!.parts![1].functionCall!.id;

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).toMatch(/^adk-[a-f0-9-]{36}$/);
    expect(id2).toMatch(/^adk-[a-f0-9-]{36}$/);
    expect(id1).not.toBe(id2);
  });

  it('should generate standalone client function call IDs with adk- prefix', () => {
    const id = generateClientFunctionCallId();
    expect(id).toMatch(/^adk-[a-f0-9-]{36}$/);
  });
});
