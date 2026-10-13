/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  createSession,
  GoogleApiSpec,
  GoogleApiToolSet,
  InvocationContext,
  isGoogleApiTool,
  isGoogleApiToolSet,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

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

const MOCK_OPENAPI_SPEC: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Calendar API', version: 'v3'},
  servers: [{url: 'https://www.googleapis.com/calendar/v3'}],
  paths: {
    '/calendars/{calendarId}': {
      get: {
        operationId: 'getCalendar',
        description: 'Get calendar',
        parameters: [
          {
            name: 'calendarId',
            in: 'path',
            required: true,
            schema: {type: 'string'},
          },
        ],
        responses: {'200': {description: 'OK'}},
      },
    },
    '/calendars': {
      post: {
        operationId: 'insertCalendar',
        description: 'Insert calendar',
        responses: {'200': {description: 'OK'}},
      },
    },
  },
};

describe('GoogleApiToolSet', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, {recursive: true, force: true});
      tempDir = undefined;
    }
  });

  it('builds an OpenAPIToolset with Google OIDC auth from a spec dictionary', async () => {
    const openapiToolset = GoogleApiToolSet.loadToolSetWithOidcAuth({
      specDict: MOCK_OPENAPI_SPEC,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const restTools = await openapiToolset.getTools();
    expect(restTools.length).toBe(2);
    expect(restTools.map((t) => t.name)).toEqual([
      'get_calendar',
      'insert_calendar',
    ]);
  });

  it('loads an OpenAPI YAML file relative to callerDir in loadToolSetWithOidcAuth', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-oidc-spec-'));
    const specFileName = 'calendar_spec.json';
    fs.writeFileSync(
      path.join(tempDir, specFileName),
      JSON.stringify(MOCK_OPENAPI_SPEC),
      'utf-8',
    );

    const openapiToolset = GoogleApiToolSet.loadToolSetWithOidcAuth({
      specFile: specFileName,
      callerDir: tempDir,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const tools = await openapiToolset.getTools();
    expect(tools.length).toBe(2);
  });

  it('loads a GoogleApiToolSet from Discovery via loadToolSet', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = await GoogleApiToolSet.loadToolSet('calendar', 'v3');
    expect(isGoogleApiToolSet(toolset)).toBe(true);

    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools.every((t) => isGoogleApiTool(t))).toBe(true);

    const getTool = await toolset.getTool('calendar_calendars_get');
    expect(getTool).toBeDefined();
    expect(getTool?.name).toBe('calendar_calendars_get');

    const missingTool = await toolset.getTool('nonexistent_tool');
    expect(missingTool).toBeUndefined();
  });

  it('filters tools with string[] and ToolPredicate via toolFilter', async () => {
    const openapiToolset = GoogleApiToolSet.loadToolSetWithOidcAuth({
      specDict: MOCK_OPENAPI_SPEC,
    });
    const restTools = (await openapiToolset.getTools()) as RestApiTool[];
    const listFilteredToolset = new GoogleApiToolSet(restTools, {
      toolFilter: ['get_calendar'],
    });

    const filteredByList = await listFilteredToolset.getTools();
    expect(filteredByList.map((t) => t.name)).toEqual(['get_calendar']);

    const predicateFilteredToolset = new GoogleApiToolSet(restTools, {
      toolFilter: (tool) => tool.name === 'insert_calendar',
    });
    const readonlyContext = new ReadonlyContext(
      new InvocationContext({
        invocationId: 'inv-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
    );
    const filteredByPredicate =
      await predicateFilteredToolset.getTools(readonlyContext);
    expect(filteredByPredicate.map((t) => t.name)).toEqual(['insert_calendar']);

    await expect(listFilteredToolset.close()).resolves.toBeUndefined();
  });

  it('deduplicates concurrent first getTools and getTool calls on a lazy toolset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const lazyToolset = new GoogleApiToolSet(undefined, {
      apiName: 'calendar',
      apiVersion: 'v3',
    });

    const [firstTools, secondTools, singleTool] = await Promise.all([
      lazyToolset.getTools(),
      lazyToolset.getTools(),
      lazyToolset.getTool('calendar_calendars_get'),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(firstTools.length).toBe(2);
    expect(secondTools.length).toBe(2);
    expect(singleTool?.name).toBe('calendar_calendars_get');
  });

  it('propagates configureAuth to loaded and lazily loaded GoogleApiTool instances', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const lazyToolset = new GoogleApiToolSet(undefined, {
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    lazyToolset.configureAuth('lazy-client-id', 'lazy-client-secret');

    const tools = await lazyToolset.getTools();
    expect(tools.length).toBe(2);

    const configureSpy = vi.spyOn(
      tools[0].restApiTool,
      'configureAuthCredential',
    );
    lazyToolset.configureAuth('updated-id', 'updated-secret');
    expect(configureSpy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'updated-id',
        clientSecret: 'updated-secret',
      },
    });
  });
});
