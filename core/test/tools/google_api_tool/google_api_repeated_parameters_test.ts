/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleApiToolset} from '@google/adk';
import {Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('Google Discovery repeated parameters', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exposes Calendar event type filters as arrays with item constraints', async () => {
    // Calendar v3 Discovery: resources.events.methods.list.parameters.eventTypes.
    const spec = {
      name: 'calendar',
      version: 'v3',
      rootUrl: 'https://www.googleapis.com/',
      servicePath: 'calendar/v3/',
      resources: {
        events: {
          methods: {
            list: {
              id: 'calendar.events.list',
              path: 'calendars/{calendarId}/events',
              httpMethod: 'GET',
              parameters: {
                calendarId: {type: 'string', location: 'path', required: true},
                eventTypes: {
                  type: 'string',
                  location: 'query',
                  repeated: true,
                  enum: ['default', 'outOfOffice'],
                },
                maxResults: {
                  type: 'integer',
                  location: 'query',
                  format: 'int32',
                },
              },
            },
          },
        },
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      json: async () => spec,
    } as Response);

    const tools = await new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    }).getTools();
    expect(tools).toHaveLength(1);
    const parameters = tools[0]._getDeclaration().parameters!;
    expect(parameters.properties?.['event_types']).toMatchObject({
      type: Type.ARRAY,
      items: {type: Type.STRING, enum: ['default', 'outOfOffice']},
    });
    expect(parameters.properties?.['event_types']?.enum).toBeUndefined();
    expect(parameters.properties?.['max_results']?.type).toBe(Type.INTEGER);
  });
});
