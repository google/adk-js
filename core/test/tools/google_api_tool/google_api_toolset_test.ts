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
  GoogleApiToolset,
  InvocationContext,
  isGoogleApiTool,
  isGoogleApiToolset,
  LlmAgent,
  OpenAPIToolset,
  OpenIdConnectWithConfig,
  PluginManager,
  ReadonlyContext,
  ServiceAccount,
  ServiceAccountCredentialExchanger,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {GoogleApiSpec} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';

function createTestServiceAccount(
  scopes: string[] = ['scope1', 'scope2'],
): ServiceAccount {
  return {
    serviceAccountCredential: {
      type: 'service_account',
      projectId: 'project-id',
      privateKeyId: 'private-key-id',
      privateKey: 'private-key',
      clientEmail: 'test@example.iam.gserviceaccount.com',
      clientId: 'client-id',
      authUri: 'https://accounts.google.com/o/oauth2/auth',
      tokenUri: 'https://oauth2.googleapis.com/token',
      authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
      clientX509CertUrl:
        'https://www.googleapis.com/robot/v1/metadata/x509/test',
      universeDomain: 'googleapis.com',
    },
    scopes,
  };
}

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

  it('stores the api name, version and tool filter from the constructor options', () => {
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
    expect(toolset.scopes).toBeUndefined();
  });

  it('throws when apiName or apiVersion is missing', async () => {
    await expect(new GoogleApiToolset().getTools()).rejects.toThrow(
      'Both apiName and apiVersion are required to load a GoogleApiToolset.',
    );
    await expect(
      new GoogleApiToolset({apiName: 'calendar'}).getTools(),
    ).rejects.toThrow(
      'Both apiName and apiVersion are required to load a GoogleApiToolset.',
    );
    await expect(
      new GoogleApiToolset({apiVersion: 'v3'}).getTools(),
    ).rejects.toThrow(
      'Both apiName and apiVersion are required to load a GoogleApiToolset.',
    );
  });

  it('configures custom OAuth scopes on the underlying OIDC auth scheme when provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const customScopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      scopes: customScopes,
    });

    expect(toolset.scopes).toEqual(customScopes);

    const tools = await toolset.getTools();
    const tool = tools[0];

    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-custom-scopes',
    });

    await tool.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    const requestedAuth =
      context.eventActions.requestedAuthConfigs['call-custom-scopes'];
    expect(requestedAuth).toBeDefined();
    const oidcScheme = requestedAuth.authScheme as OpenIdConnectWithConfig;
    expect(oidcScheme.scopes).toEqual(customScopes);
  });

  it('defaults to the first scope from the discovery spec when scopes option is omitted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
    });

    expect(toolset.scopes).toBeUndefined();

    const tools = await toolset.getTools();
    const tool = tools[0];

    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-2',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-2', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-default-scopes',
    });

    await tool.runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    const requestedAuth =
      context.eventActions.requestedAuthConfigs['call-default-scopes'];
    expect(requestedAuth).toBeDefined();
    const oidcScheme = requestedAuth.authScheme as OpenIdConnectWithConfig;
    expect(oidcScheme.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar',
    ]);
  });

  it('creates a GoogleApiTool for every method in the discovery spec', async () => {
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

  it('returns only the tools named in a tool filter list', async () => {
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

  it('returns only the tools that match a tool filter predicate', async () => {
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

  it('applies configured auth credentials to the tools it creates and to existing tools', async () => {
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

  it('forwards serviceAccount from constructor options to created tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);
    const configureSaSpy = vi.spyOn(GoogleApiTool.prototype, 'configureSaAuth');
    const serviceAccount = createTestServiceAccount();

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      serviceAccount,
    });

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(2);
    expect(configureSaSpy).toHaveBeenCalledTimes(2);
    expect(configureSaSpy).toHaveBeenCalledWith(serviceAccount);
  });

  it('applies service account credentials to tools loaded later and to already-loaded tools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);
    const configureSaSpy = vi.spyOn(GoogleApiTool.prototype, 'configureSaAuth');
    const initialServiceAccount = createTestServiceAccount(['scope1']);
    const updatedServiceAccount = createTestServiceAccount(['scope2']);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    toolset.configureSaAuth(initialServiceAccount);

    const tools = await toolset.getTools();
    expect(tools).toHaveLength(2);
    expect(configureSaSpy).toHaveBeenCalledTimes(2);
    expect(configureSaSpy).toHaveBeenCalledWith(initialServiceAccount);

    configureSaSpy.mockClear();
    toolset.configureSaAuth(updatedServiceAccount);
    expect(configureSaSpy).toHaveBeenCalledTimes(2);
    expect(configureSaSpy).toHaveBeenCalledWith(updatedServiceAccount);
  });

  it('exchanges serviceAccount credentials and sends a bearer token when running a tool', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_DISCOVERY_SPEC,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({id: 'primary', summary: 'Primary'}),
      } as Response);
    const exchangeSpy = vi
      .spyOn(ServiceAccountCredentialExchanger.prototype, 'exchange')
      .mockResolvedValue({
        credential: {
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token: 'sa-access-token'},
          },
        },
        wasExchanged: true,
      });

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      serviceAccount: createTestServiceAccount(),
    });

    const tools = await toolset.getTools();
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-sa-exec',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-sa-exec', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-sa-exec',
    });

    const result = await tools[0].runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    expect(result).toEqual({id: 'primary', summary: 'Primary'});
    expect(exchangeSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sa-access-token',
        }),
      }),
    );
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('uses OpenID Connect auth when configureAuth follows configureSaAuth before getTools', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_DISCOVERY_SPEC,
    } as Response);

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
    });
    toolset.configureSaAuth(createTestServiceAccount());
    toolset.configureAuth('oidc-client-id', 'oidc-client-secret');

    const tools = await toolset.getTools();
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-switch-before',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-switch-before', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-switch-before',
    });

    await tools[0].runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    const requestedAuth =
      context.eventActions.requestedAuthConfigs['call-switch-before'];
    expect(requestedAuth).toBeDefined();
    expect(requestedAuth.authScheme).toEqual(
      expect.objectContaining({
        type: 'openIdConnect',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/calendar'],
      }),
    );
    expect(requestedAuth.rawAuthCredential).toEqual({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'oidc-client-id',
        clientSecret: 'oidc-client-secret',
      },
    });
  });

  it('restores the OpenID Connect auth scheme when configureAuth follows configureSaAuth after getTools', async () => {
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
    toolset.configureSaAuth(createTestServiceAccount());
    toolset.configureAuth('updated-client-id', 'updated-client-secret');

    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-switch-after',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-switch-after', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-switch-after',
    });

    await tools[0].runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    const requestedAuth =
      context.eventActions.requestedAuthConfigs['call-switch-after'];
    expect(requestedAuth).toBeDefined();
    expect(requestedAuth.authScheme).toEqual(
      expect.objectContaining({
        type: 'openIdConnect',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        scopes: ['https://www.googleapis.com/auth/calendar'],
      }),
    );
    expect(requestedAuth.rawAuthCredential).toEqual({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {
        clientId: 'updated-client-id',
        clientSecret: 'updated-client-secret',
      },
    });
  });

  it('uses serviceAccount auth when configureSaAuth follows configureAuth before getTools', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => MOCK_DISCOVERY_SPEC,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({id: 'primary', summary: 'Primary'}),
      } as Response);
    vi.spyOn(
      ServiceAccountCredentialExchanger.prototype,
      'exchange',
    ).mockResolvedValue({
      credential: {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'sa-switched-token'},
        },
      },
      wasExchanged: true,
    });

    const toolset = new GoogleApiToolset({
      apiName: 'calendar',
      apiVersion: 'v3',
      clientId: 'initial-client-id',
      clientSecret: 'initial-client-secret',
    });
    toolset.configureSaAuth(createTestServiceAccount());

    const tools = await toolset.getTools();
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-switch-sa',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'sess-switch-sa', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
      functionCallId: 'call-switch-sa',
    });

    await tools[0].runAsync({
      args: {calendar_id: 'primary'},
      toolContext: context,
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'https://www.googleapis.com/calendar/v3/calendars/primary',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer sa-switched-token',
        }),
      }),
    );
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('applies a list or predicate filter set after construction', async () => {
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

  it('closes the underlying OpenAPI toolset only after tools are loaded', async () => {
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
