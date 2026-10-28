/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  GoogleApiTool,
  GoogleApiToolset,
  InvocationContext,
  isGoogleApiTool,
  isGoogleApiToolset,
  LlmAgent,
  OpenAPIToolset,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {GoogleApiSpec} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';

const MOCK_DISCOVERY_SPEC: GoogleApiSpec = {
  kind: 'discovery#restDescription',
  id: 'calendar:v3',
  name: 'calendar',
  version: 'v3',
  title: 'Google Calendar API',
  description: 'Accesses the Google Calendar API',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'calendar/v3/',
  auth: {
    oauth2: {
      scopes: {
        'https://www.googleapis.com/auth/calendar': {
          description: 'Full access to Google Calendar',
        },
        'https://www.googleapis.com/auth/calendar.readonly': {
          description: 'Read-only access to Google Calendar',
        },
      },
    },
  },
  schemas: {
    Calendar: {
      type: 'object',
      properties: {
        id: {type: 'string'},
        summary: {type: 'string', required: true},
      },
    },
  },
  resources: {
    calendars: {
      methods: {
        get: {
          id: 'calendar.calendars.get',
          path: 'calendars/{calendarId}',
          httpMethod: 'GET',
          description: 'Returns metadata for a calendar.',
          parameters: {
            calendarId: {
              type: 'string',
              required: true,
              location: 'path',
            },
          },
          response: {$ref: 'Calendar'},
          scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
        },
        insert: {
          id: 'calendar.calendars.insert',
          path: 'calendars',
          httpMethod: 'POST',
          description: 'Creates a secondary calendar.',
          request: {$ref: 'Calendar'},
          response: {$ref: 'Calendar'},
          scopes: ['https://www.googleapis.com/auth/calendar'],
        },
      },
    },
  },
};

describe('GoogleApiToolset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_init', () => {
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      toolFilter: ['calendar_calendars_get'],
    });

    expect(isGoogleApiToolset(toolset)).toBe(true);
    expect(toolset.apiName).toBe('calendar');
    expect(toolset.apiVersion).toBe('v3');
    expect(toolset.toolFilter).toEqual(['calendar_calendars_get']);
  });

  it('test_get_tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools.every((t) => isGoogleApiTool(t))).toBe(true);
    expect(tools.map((t) => t.name)).toEqual([
      'calendar_calendars_get',
      'calendar_calendars_insert',
    ]);
  });

  it('test_get_tools_with_filter_list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolFilter: ['calendar_calendars_get'],
    });

    const tools = await toolset.getTools();
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calendar_calendars_get');
  });

  it('test_get_tools_with_filter_predicate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      toolFilter: (tool) => tool.name === 'calendar_calendars_insert',
    });

    const readonlyContext = new ReadonlyContext(
      new InvocationContext({
        invocationId: 'inv-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
    );

    const tools = await toolset.getTools(readonlyContext);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('calendar_calendars_insert');
  });

  it('test_configure_auth', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);
    const configureSpy = vi.spyOn(GoogleApiTool.prototype, 'configureAuth');

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    toolset.configureAuth('lazy-client-id', 'lazy-client-secret');

    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(configureSpy).toHaveBeenCalledWith(
      'lazy-client-id',
      'lazy-client-secret',
    );

    toolset.configureAuth('updated-id', 'updated-secret');
    expect(configureSpy).toHaveBeenCalledWith('updated-id', 'updated-secret');
  });

  it('test_set_tool_filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    const allTools = await toolset.getTools();
    expect(allTools.length).toBe(2);

    toolset.setToolFilter(['calendar_calendars_insert']);
    const listFiltered = await toolset.getTools();
    expect(listFiltered.map((t) => t.name)).toEqual([
      'calendar_calendars_insert',
    ]);

    toolset.setToolFilter((tool) => tool.name === 'calendar_calendars_get');
    const predicateFiltered = await toolset.getTools();
    expect(predicateFiltered.map((t) => t.name)).toEqual([
      'calendar_calendars_get',
    ]);
  });

  it('test_close', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);
    const closeSpy = vi.spyOn(OpenAPIToolset.prototype, 'close');

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await toolset.close();
    expect(closeSpy).not.toHaveBeenCalled();

    await toolset.getTools();
    await toolset.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent first getTools calls on a lazy toolset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    const [firstTools, secondTools] = await Promise.all([
      toolset.getTools(),
      toolset.getTools(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(firstTools.length).toBe(2);
    expect(secondTools.length).toBe(2);
  });

  it('clears the cached loading promise on failure so subsequent attempts retry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_DISCOVERY_SPEC,
      } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    await expect(toolset.getTools()).rejects.toThrow();

    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
