/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createSession,
  GoogleApiTool,
  InvocationContext,
  isGoogleApiTool,
  LlmAgent,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

function createTestRestApiTool(): RestApiTool {
  const endpoint = {
    baseUrl: 'https://www.googleapis.com/calendar/v3',
    path: '/calendars/{calendarId}',
    method: 'GET',
  };
  const operation: OpenAPIV3.OperationObject = {
    operationId: 'calendar.calendars.get',
    description: 'Returns metadata for a calendar.',
    parameters: [
      {
        name: 'calendarId',
        in: 'path',
        required: true,
        schema: {type: 'string'},
      },
    ],
    responses: {
      '200': {description: 'Successful operation'},
    },
  };
  return new RestApiTool(
    'calendar_calendars_get',
    'Returns metadata for a calendar.',
    endpoint,
    operation,
  );
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'sess-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('GoogleApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies name, description, and isLongRunning from the wrapped RestApiTool', () => {
    const restApiTool = createTestRestApiTool();
    const googleApiTool = new GoogleApiTool(restApiTool);

    expect(googleApiTool.name).toBe('calendar_calendars_get');
    expect(googleApiTool.description).toBe('Returns metadata for a calendar.');
    expect(googleApiTool.isLongRunning).toBe(false);
    expect(googleApiTool.restApiTool).toBe(restApiTool);
    expect(isGoogleApiTool(googleApiTool)).toBe(true);
    expect(isGoogleApiTool(restApiTool)).toBe(false);
  });

  it('delegates _getDeclaration to the wrapped RestApiTool', () => {
    const restApiTool = createTestRestApiTool();
    const googleApiTool = new GoogleApiTool(restApiTool);

    const declaration = googleApiTool._getDeclaration();
    expect(declaration).toEqual(restApiTool._getDeclaration());
    expect(declaration.name).toBe('calendar_calendars_get');
  });

  it('delegates runAsync to the wrapped RestApiTool', async () => {
    const restApiTool = createTestRestApiTool();
    const googleApiTool = new GoogleApiTool(restApiTool);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({id: 'primary', summary: 'Primary'}),
    } as Response);

    const result = await googleApiTool.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({id: 'primary', summary: 'Primary'});
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      expect.objectContaining({method: 'GET'}),
    );
  });

  it('configures OpenID Connect credentials on the wrapped RestApiTool', () => {
    const restApiTool = createTestRestApiTool();
    const configureSpy = vi.spyOn(restApiTool, 'configureAuthCredential');
    const googleApiTool = new GoogleApiTool(restApiTool);

    googleApiTool.configureAuth('my-client-id', 'my-client-secret');

    expect(configureSpy).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'my-client-id',
        clientSecret: 'my-client-secret',
      },
    });
  });
});
