/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  AuthSchemeType,
  Context,
  createSession,
  InMemoryCredentialService,
  InvocationContext,
  isBaseAuthenticatedTool,
  isBaseTool,
  MCPSessionManager,
  MCPTool,
  MCPToolOptions,
} from '@google/adk';
import {Type} from '@google/genai';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Tool} from '@modelcontextprotocol/sdk/types.js';
import {afterEach, describe, expect, it, vi} from 'vitest';
// The logger singleton is internal (not part of the public API), so it is
// imported via a relative path to spy on the exact instance the tool uses.
import {logger} from '../../../src/utils/logger.js';

describe('MCPTool', () => {
  it('passes abort signal to callTool', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
      getRequestOptions: vi.fn((signal?: AbortSignal) =>
        signal ? {signal} : {},
      ),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('uses originalName for callTool when provided', async () => {
    const mockTool: Tool = {
      name: 'prefixed_test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
      getRequestOptions: vi.fn((signal?: AbortSignal) =>
        signal ? {signal} : {},
      ),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager, 'test-tool');

    const controller = new AbortController();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'test-tool', arguments: {}},
      undefined,
      {signal: signal},
    );
  });

  it('respects abort signal when callTool rejects', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockImplementation((_params, _extra, options) => {
        if (options?.signal?.aborted) {
          return Promise.reject(new Error('Aborted'));
        }
        return Promise.resolve({content: []});
      }),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
      getRequestOptions: vi.fn((signal?: AbortSignal) =>
        signal ? {signal} : {},
      ),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const controller = new AbortController();
    controller.abort();
    const signal = controller.signal;

    const invocationContext = {
      abortSignal: signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Aborted',
    );
  });

  it('closes session even when callTool throws an error', async () => {
    const mockTool: Tool = {
      name: 'test-tool',
      description: 'A test tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockRejectedValue(new Error('Call failed')),
    } as unknown as Client;

    const mockSessionManager = {
      createSession: vi.fn().mockResolvedValue(mockClient),
      closeSession: vi.fn().mockResolvedValue(undefined),
      getRequestOptions: vi.fn((signal?: AbortSignal) =>
        signal ? {signal} : {},
      ),
    } as unknown as MCPSessionManager;

    const tool = new MCPTool(mockTool, mockSessionManager);

    const invocationContext = {
      abortSignal: new AbortController().signal,
      session: {state: {}},
    } as unknown as InvocationContext;

    const toolContext = new Context({invocationContext});

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Call failed',
    );

    // Assert that closeSession was still called despite the error
    expect(mockSessionManager.closeSession).toHaveBeenCalledWith(mockClient);
  });

  it('passes stdio timeout and abort signal from sessionManager.getRequestOptions to callTool', async () => {
    const mockTool: Tool = {
      name: 'stdio-tool',
      description: 'An stdio tool',
      inputSchema: {type: 'object', properties: {}},
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({content: []}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;

    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test'},
      timeout: 8,
    });
    vi.spyOn(sessionManager, 'createSession').mockResolvedValue(mockClient);
    vi.spyOn(sessionManager, 'closeSession').mockResolvedValue(undefined);

    const tool = new MCPTool(mockTool, sessionManager);
    const controller = new AbortController();
    const invocationContext = {
      abortSignal: controller.signal,
      session: {state: {}},
    } as unknown as InvocationContext;
    const toolContext = new Context({invocationContext});

    await tool.runAsync({args: {query: 'hello'}, toolContext});

    expect(mockClient.callTool).toHaveBeenCalledWith(
      {name: 'stdio-tool', arguments: {query: 'hello'}},
      undefined,
      {signal: controller.signal, timeout: 8000},
    );
  });

  describe('initialization and declaration', () => {
    const sessionManager = new MCPSessionManager({
      type: 'StdioConnectionParams',
      serverParams: {command: 'test'},
    });

    it('initializes BaseTool properties and satisfies isBaseTool', () => {
      const mcpTool: Tool = {
        name: 'test-tool',
        description: 'A test tool',
        inputSchema: {type: 'object', properties: {}},
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(isBaseTool(tool)).toBe(true);
      expect(tool.name).toBe('test-tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.isLongRunning).toBe(false);
    });

    it('defaults description to an empty string when mcpTool.description is undefined', () => {
      const mcpTool: Tool = {
        name: 'undescribed-tool',
        inputSchema: {type: 'object', properties: {}},
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(isBaseTool(tool)).toBe(true);
      expect(tool.name).toBe('undescribed-tool');
      expect(tool.description).toBe('');
    });

    it('builds a FunctionDeclaration with converted inputSchema and outputSchema', () => {
      const mcpTool: Tool = {
        name: 'weather-tool',
        description: 'Gets weather for a city',
        inputSchema: {
          type: 'object',
          properties: {
            city: {type: 'string', description: 'City name'},
          },
          required: ['city'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            temperature: {type: 'number'},
          },
          required: ['temperature'],
        },
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(tool._getDeclaration()).toEqual({
        name: 'weather-tool',
        description: 'Gets weather for a city',
        parameters: {
          type: Type.OBJECT,
          properties: {
            city: {type: Type.STRING, description: 'City name'},
          },
          required: ['city'],
        },
        response: {
          type: Type.OBJECT,
          properties: {
            temperature: {type: Type.NUMBER},
          },
          required: ['temperature'],
        },
      });
    });

    it('leaves response undefined in FunctionDeclaration when outputSchema is omitted', () => {
      const mcpTool: Tool = {
        name: 'simple-tool',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      };

      const tool = new MCPTool(mcpTool, sessionManager);

      expect(tool._getDeclaration()).toEqual({
        name: 'simple-tool',
        description: undefined,
        parameters: {
          type: Type.OBJECT,
          properties: {},
        },
        response: undefined,
      });
    });
  });

  describe('authentication', () => {
    const authTool: Tool = {
      name: 'auth-tool',
      description: 'A tool behind auth',
      inputSchema: {type: 'object', properties: {}},
    };

    const oauth2Scheme: AuthScheme = {
      type: AuthSchemeType.OAUTH2,
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {read: 'Read access'},
        },
      },
    };

    const oauth2Credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    };

    const oauth2AuthConfig: AuthConfig = {
      authScheme: oauth2Scheme,
      rawAuthCredential: oauth2Credential,
      credentialKey: 'mcp-oauth2-key',
    };

    const apiKeyScheme: AuthScheme = {
      type: AuthSchemeType.API_KEY,
      in: 'header',
      name: 'X-Custom-Key',
    };

    const apiKeyCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'api-key-1',
    };

    function createMocks() {
      const client = {
        callTool: vi.fn().mockResolvedValue({content: []}),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const sessionManager = {
        createSession: vi.fn().mockResolvedValue(client),
        closeSession: vi.fn().mockResolvedValue(undefined),
        getRequestOptions: vi.fn(() => ({})),
      };
      return {
        client,
        sessionManager,
        mcpSessionManager: sessionManager as unknown as MCPSessionManager,
      };
    }

    function createToolContext(
      options: {
        state?: Record<string, unknown>;
        credentialService?: InMemoryCredentialService;
      } = {},
    ): Context {
      const invocationContext = {
        abortSignal: new AbortController().signal,
        session: createSession({
          id: 'session-1',
          appName: 'test-app',
          userId: 'user-1',
          state: options.state ?? {},
        }),
        credentialService:
          options.credentialService ?? new InMemoryCredentialService(),
      } as unknown as InvocationContext;
      return new Context({invocationContext, functionCallId: 'call-1'});
    }

    function bearerAuthConfig(rawAuthCredential?: AuthCredential): AuthConfig {
      return {
        authScheme: {type: AuthSchemeType.HTTP, scheme: 'bearer'},
        rawAuthCredential,
        credentialKey: 'mcp-test-key',
      };
    }

    function requestedCredentialKey(toolContext: Context): string | undefined {
      return toolContext.eventActions.requestedAuthConfigs['call-1']
        ?.credentialKey;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('opens the session without headers when the tool has no authConfig', async () => {
      const {client, sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({mcpTool: authTool, mcpSessionManager});

      await tool.runAsync({args: {q: 'x'}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith(undefined);
      expect(client.callTool).toHaveBeenCalledWith(
        {name: 'auth-tool', arguments: {q: 'x'}},
        undefined,
        {},
      );
      expect(sessionManager.closeSession).toHaveBeenCalledWith(client);
    });

    it('requests a credential and opens no session when none is available', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: oauth2AuthConfig,
      });
      const toolContext = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext});

      expect(isBaseAuthenticatedTool(tool)).toBe(true);
      expect(isBaseTool(tool)).toBe(true);
      expect(result).toBe('Pending User Authorization.');
      expect(requestedCredentialKey(toolContext)).toBe('mcp-oauth2-key');
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('sends a stored OAuth2 access token as a Bearer header', async () => {
      const {client, sessionManager, mcpSessionManager} = createMocks();
      const credentialService = new InMemoryCredentialService();
      const toolContext = createToolContext({credentialService});
      await credentialService.saveCredential(
        {
          ...oauth2AuthConfig,
          exchangedAuthCredential: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {accessToken: 'oauth-token'},
          },
        },
        toolContext,
      );
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: oauth2AuthConfig,
      });

      await tool.runAsync({args: {q: 'x'}, toolContext});

      expect(requestedCredentialKey(toolContext)).toBeUndefined();
      expect(sessionManager.createSession).toHaveBeenCalledWith({
        Authorization: 'Bearer oauth-token',
      });
      expect(client.callTool).toHaveBeenCalledWith(
        {name: 'auth-tool', arguments: {q: 'x'}},
        undefined,
        {},
      );
    });

    it('sends no header for an OAuth2 credential without an access token', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const toolContext = createToolContext({
        state: {
          'temp:mcp-oauth2-key': {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {clientId: 'client-id'},
            http: {scheme: 'bearer', credentials: {token: 'unrelated-token'}},
          },
        },
      });
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: oauth2AuthConfig,
      });

      await tool.runAsync({args: {}, toolContext});

      expect(sessionManager.createSession).toHaveBeenCalledWith(undefined);
    });

    it.each([
      {
        label: 'a bearer token as a Bearer header',
        scheme: 'bearer',
        credentials: {token: 'bearer-token'},
        expected: {Authorization: 'Bearer bearer-token'},
      },
      {
        label: 'basic credentials as a base64 Basic header',
        scheme: 'basic',
        credentials: {username: 'user', password: 'pass'},
        expected: {Authorization: 'Basic dXNlcjpwYXNz'},
      },
      {
        label: 'a token for another scheme with that scheme name',
        scheme: 'Token',
        credentials: {token: 'abc'},
        expected: {Authorization: 'Token abc'},
      },
    ])('sends $label', async ({scheme, credentials, expected}) => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig({
          authType: AuthCredentialTypes.HTTP,
          http: {scheme, credentials},
        }),
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith(expected);
    });

    it('sends no header for basic auth without a password', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig({
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'basic', credentials: {username: 'user'}},
        }),
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith(undefined);
    });

    it('sends only the additionalHeaders of an HTTP credential with no credentials field', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const toolContext = createToolContext({
        state: {
          'temp:mcp-test-key': {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', additionalHeaders: {'X-Tenant': 't-1'}},
          },
        },
      });
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig(),
      });

      await tool.runAsync({args: {}, toolContext});

      expect(sessionManager.createSession).toHaveBeenCalledWith({
        'X-Tenant': 't-1',
      });
    });

    it('adds the HTTP additionalHeaders to the auth header', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig({
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token: 'bearer-token'},
            additionalHeaders: {'X-Tenant': 'tenant-1'},
          },
        }),
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith({
        'Authorization': 'Bearer bearer-token',
        'X-Tenant': 'tenant-1',
      });
    });

    it('lets an additional header replace the auth header of the same name in any casing', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig({
          authType: AuthCredentialTypes.HTTP,
          http: {
            scheme: 'bearer',
            credentials: {token: 'bearer-token'},
            additionalHeaders: {authorization: 'Custom override'},
          },
        }),
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith({
        authorization: 'Custom override',
      });
    });

    it('sends an API key in the header named by the apiKey scheme', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: {
          authScheme: apiKeyScheme,
          rawAuthCredential: apiKeyCredential,
          credentialKey: 'mcp-api-key',
        },
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith({
        'X-Custom-Key': 'api-key-1',
      });
    });

    it('rejects an API key outside the header and opens no session', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: {
          authScheme: {type: AuthSchemeType.API_KEY, in: 'query', name: 'key'},
          rawAuthCredential: apiKeyCredential,
          credentialKey: 'mcp-api-key',
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        "MCPTool only supports header-based API key authentication. Configured location: 'query'.",
      );
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('rejects an apiKey scheme with a blank header name and opens no session', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: {
          authScheme: {type: AuthSchemeType.API_KEY, in: 'header', name: '  '},
          rawAuthCredential: apiKeyCredential,
          credentialKey: 'mcp-api-key',
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        'MCPTool needs a header name in the apiKey auth scheme to send an API key credential.',
      );
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('rejects an API key credential without an apiKey scheme', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: bearerAuthConfig(apiKeyCredential),
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        "MCPTool needs an apiKey auth scheme to send an API key credential, but the auth scheme type is 'http'.",
      );
      expect(sessionManager.createSession).not.toHaveBeenCalled();
    });

    it('warns and sends no header for a service account credential', async () => {
      const {sessionManager, mcpSessionManager} = createMocks();
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const tool = new MCPTool({
        mcpTool: authTool,
        mcpSessionManager,
        authConfig: {
          authScheme: {
            type: AuthSchemeType.OAUTH2,
            flows: {
              clientCredentials: {
                tokenUrl: 'https://example.com/token',
                scopes: {},
              },
            },
          },
          rawAuthCredential: {
            authType: AuthCredentialTypes.SERVICE_ACCOUNT,
            serviceAccount: {scopes: ['https://example.com/scope']},
          },
          credentialKey: 'mcp-service-account',
        },
      });

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(sessionManager.createSession).toHaveBeenCalledWith(undefined);
      expect(warnSpy).toHaveBeenCalledWith(
        'Service account credentials should be exchanged before MCP session creation.',
      );
    });

    describe('authScheme and authCredential options', () => {
      it('sends the header for an authScheme and authCredential', async () => {
        const {sessionManager, mcpSessionManager} = createMocks();
        const tool = new MCPTool({
          mcpTool: authTool,
          mcpSessionManager,
          authScheme: apiKeyScheme,
          authCredential: apiKeyCredential,
        });

        await tool.runAsync({args: {}, toolContext: createToolContext()});

        expect(isBaseAuthenticatedTool(tool)).toBe(true);
        expect(sessionManager.createSession).toHaveBeenCalledWith({
          'X-Custom-Key': 'api-key-1',
        });
      });

      it('uses the given credentialKey', async () => {
        const {mcpSessionManager} = createMocks();
        const tool = new MCPTool({
          mcpTool: authTool,
          mcpSessionManager,
          authScheme: oauth2Scheme,
          authCredential: oauth2Credential,
          credentialKey: 'custom-key',
        });
        const toolContext = createToolContext();

        await tool.runAsync({args: {}, toolContext});

        expect(requestedCredentialKey(toolContext)).toBe('custom-key');
      });

      it('derives a credentialKey that ignores the transient OAuth2 fields', async () => {
        const {mcpSessionManager} = createMocks();
        const keyFor = async (credential: AuthCredential) => {
          const toolContext = createToolContext();
          await new MCPTool({
            mcpTool: authTool,
            mcpSessionManager,
            authScheme: oauth2Scheme,
            authCredential: credential,
          }).runAsync({args: {}, toolContext});
          return requestedCredentialKey(toolContext);
        };

        const plainKey = await keyFor(oauth2Credential);
        const withTokenKey = await keyFor({
          ...oauth2Credential,
          oauth2: {
            ...oauth2Credential.oauth2,
            state: 'state-1',
            accessToken: 'token-1',
          },
        });
        const otherClientKey = await keyFor({
          ...oauth2Credential,
          oauth2: {clientId: 'other-client', clientSecret: 'client-secret'},
        });

        expect(plainKey).toMatch(/^adk_oauth2_[0-9a-f]+_oauth2_[0-9a-f]+$/);
        expect(withTokenKey).toBe(plainKey);
        expect(otherClientKey).not.toBe(plainKey);
      });

      it('rejects authConfig given together with authScheme', () => {
        const {mcpSessionManager} = createMocks();

        expect(
          () =>
            new MCPTool({
              mcpTool: authTool,
              mcpSessionManager,
              authConfig: oauth2AuthConfig,
              authScheme: oauth2Scheme,
            }),
        ).toThrow(
          'MCPTool takes either authConfig or authScheme, authCredential and credentialKey, not both.',
        );
      });

      it('rejects authCredential without authScheme', () => {
        const {mcpSessionManager} = createMocks();

        expect(
          () =>
            new MCPTool({
              mcpTool: authTool,
              mcpSessionManager,
              authCredential: apiKeyCredential,
            }),
        ).toThrow(
          'MCPTool needs an authScheme when authCredential or credentialKey is set.',
        );
      });
    });

    it('builds the same tool from the positional and options constructors', async () => {
      const prefixedTool: Tool = {...authTool, name: 'prefix_auth-tool'};
      const positional = createMocks();
      const options = createMocks();

      const fromPositional = new MCPTool(
        prefixedTool,
        positional.mcpSessionManager,
        'auth-tool',
      );
      const fromOptions = new MCPTool({
        mcpTool: prefixedTool,
        mcpSessionManager: options.mcpSessionManager,
        originalName: 'auth-tool',
      });
      await fromPositional.runAsync({
        args: {},
        toolContext: createToolContext(),
      });
      await fromOptions.runAsync({args: {}, toolContext: createToolContext()});

      expect(fromOptions.name).toBe(fromPositional.name);
      expect(fromOptions.description).toBe(fromPositional.description);
      expect(fromOptions._getDeclaration()).toEqual(
        fromPositional._getDeclaration(),
      );
      expect(options.client.callTool.mock.calls).toEqual(
        positional.client.callTool.mock.calls,
      );
      expect(options.client.callTool).toHaveBeenCalledWith(
        {name: 'auth-tool', arguments: {}},
        undefined,
        {},
      );
    });

    it('rejects options without a session manager in either form', () => {
      // A caller without type checking can leave out a required field.
      const missingManager = {mcpTool: authTool} as MCPToolOptions;
      const undefinedManager = {
        mcpTool: authTool,
        mcpSessionManager: undefined,
      } as unknown as MCPToolOptions;

      expect(() => new MCPTool(missingManager)).toThrow(
        "MCPTool 'auth-tool' needs an MCPSessionManager.",
      );
      expect(() => new MCPTool(undefinedManager)).toThrow(
        "MCPTool 'auth-tool' needs an MCPSessionManager.",
      );
    });

    it('rejects options without an MCP tool definition', () => {
      const {mcpSessionManager} = createMocks();
      const missingTool = {mcpSessionManager} as unknown as MCPToolOptions;

      expect(() => new MCPTool(missingTool)).toThrow(
        'MCPTool needs an MCP tool definition with a name.',
      );
    });
  });
});
