/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseGoogleCredentialsConfig,
  BaseLlm,
  type BaseLlmConnection,
  type Context,
  FunctionTool,
  getFunctionCalls,
  type GoogleCredentials,
  GoogleCredentialsManager,
  type GoogleOAuthCredentials,
  GoogleTool,
  InMemoryRunner,
  isFunctionTool,
  isGoogleTool,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  type RunAsyncWithCredentialRequest,
  State,
  type ToolInputParameters,
} from '@google/adk';
import {type Content, type Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

interface SampleSettings {
  maxResults: number;
}

function createMockToolContext(): Context {
  return {
    getAuthResponse: vi.fn(() => undefined),
    requestCredential: vi.fn(),
    requestConfirmation: vi.fn(),
    actions: {},
    state: new State(),
  } as unknown as Context;
}

const sampleParameters = z.object({param1: z.string()});

function sampleFunction(args: {
  param1: string;
  credentials?: GoogleCredentials;
  settings?: SampleSettings;
}): {result: string; authenticated: boolean; maxResults?: number} {
  return {
    result: `Success with ${args.param1}`,
    authenticated: args.credentials !== undefined,
    maxResults: args.settings?.maxResults,
  };
}

async function asyncSampleFunction(args: {
  param1: string;
  credentials?: GoogleCredentials;
}): Promise<{result: string; authenticated: boolean}> {
  return {
    result: `Async success with ${args.param1}`,
    authenticated: args.credentials !== undefined,
  };
}

describe('GoogleTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const credentialsConfig = new BaseGoogleCredentialsConfig({
    clientId: 'testClientId',
    clientSecret: 'testClientSecret',
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  function createSampleTool(
    config?: BaseGoogleCredentialsConfig,
    toolSettings?: SampleSettings,
  ): GoogleTool<typeof sampleParameters, SampleSettings> {
    return new GoogleTool({
      description: 'Sample Google tool',
      parameters: sampleParameters,
      execute: sampleFunction,
      credentialsConfig: config,
      toolSettings,
    });
  }

  it('identifies GoogleTool instances via isGoogleTool and preserves FunctionTool brand', () => {
    const tool = createSampleTool(credentialsConfig);
    const plainTool = new FunctionTool({
      name: 'plainFn',
      description: 'Plain function tool',
      execute: () => 'ok',
    });

    expect(isGoogleTool(tool)).toBe(true);
    expect(isFunctionTool(tool)).toBe(true);
    expect(isGoogleTool(plainTool)).toBe(false);
    expect(isGoogleTool({})).toBe(false);
    expect(isGoogleTool(null)).toBe(false);
  });

  it('rejects an anonymous execute function without a name', () => {
    expect(
      () =>
        new GoogleTool({
          description: 'Anonymous tool',
          execute: (
            () => () =>
              'ok'
          )(),
        }),
    ).toThrow(/Tool name cannot be empty/);
  });

  it('initializes credentialsManager and toolSettings conditionally', () => {
    const configured = createSampleTool(credentialsConfig, {maxResults: 25});
    expect(configured.name).toBe('sampleFunction');
    expect(configured.credentialsManager).toBeInstanceOf(
      GoogleCredentialsManager,
    );
    expect(configured.toolSettings).toEqual({maxResults: 25});
    expect(configured.ignoreParams).toContain('credentials');
    expect(configured.ignoreParams).toContain('settings');

    const unconfigured = createSampleTool();
    expect(unconfigured.credentialsManager).toBeUndefined();
    expect(unconfigured.toolSettings).toBeUndefined();
  });

  it('passes resolved credentials and toolSettings to execute', async () => {
    const tool = createSampleTool(credentialsConfig, {maxResults: 10});
    const toolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(mockCreds);

    const result = await tool.runAsync({
      args: {param1: 'testValue'},
      toolContext,
    });

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(toolContext);
    expect(result).toEqual({
      result: 'Success with testValue',
      authenticated: true,
      maxResults: 10,
    });
  });

  it('returns an authorization message while the OAuth2 flow is pending', async () => {
    const execute = vi.fn(sampleFunction);
    const tool = new GoogleTool({
      name: 'calendarTool',
      description: 'Calendar tool',
      parameters: sampleParameters,
      execute,
      credentialsConfig,
    });
    const toolContext = createMockToolContext();

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(undefined);

    const result = (await tool.runAsync({
      args: {param1: 'testValue'},
      toolContext,
    })) as string;

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(toolContext);
    expect(result.toLowerCase()).toContain('authorization is required');
    expect(result).toContain('calendarTool');
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs without credentialsManager and awaits async execute callbacks', async () => {
    const syncTool = createSampleTool();
    expect(
      await syncTool.runAsync({
        args: {param1: 'plainValue'},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      result: 'Success with plainValue',
      authenticated: false,
      maxResults: undefined,
    });

    const asyncTool = new GoogleTool({
      description: 'Async Google tool',
      parameters: sampleParameters,
      execute: asyncSampleFunction,
      credentialsConfig,
    });
    vi.spyOn(
      asyncTool.credentialsManager as GoogleCredentialsManager,
      'getValidCredentials',
    ).mockResolvedValue({valid: true, token: 'tok'});

    expect(
      await asyncTool.runAsync({
        args: {param1: 'asyncValue'},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      result: 'Async success with asyncValue',
      authenticated: true,
    });
  });

  it('catches Error instances, plain objects, and validation/credential failures into structured errors', async () => {
    const throwingTool = new GoogleTool({
      name: 'failingTool',
      description: 'Throws Error',
      execute: () => {
        throw new Error('Something went wrong');
      },
      credentialsConfig,
    });
    vi.spyOn(
      throwingTool.credentialsManager as GoogleCredentialsManager,
      'getValidCredentials',
    ).mockResolvedValue({valid: true, token: 'tok'});

    expect(
      await throwingTool.runAsync({
        args: {},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      status: 'ERROR',
      error_details: 'Something went wrong',
    });

    const objectThrowingTool = new GoogleTool({
      name: 'objectThrower',
      description: 'Throws a plain object',
      execute: () => {
        throw {code: 403, reason: 'accessDenied'};
      },
    });
    expect(
      await objectThrowingTool.runAsync({
        args: {},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      status: 'ERROR',
      error_details: '{"code":403,"reason":"accessDenied"}',
    });

    const credFailTool = createSampleTool(credentialsConfig);
    vi.spyOn(
      credFailTool.credentialsManager as GoogleCredentialsManager,
      'getValidCredentials',
    ).mockRejectedValue(new Error('No access token found'));
    expect(
      await credFailTool.runAsync({
        args: {param1: 'val'},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      status: 'ERROR',
      error_details: 'No access token found',
    });

    const validationFailResult = (await createSampleTool().runAsync({
      args: {param1: 42},
      toolContext: createMockToolContext(),
    })) as {status: string; error_details: string};
    expect(validationFailResult.status).toBe('ERROR');
    expect(validationFailResult.error_details).toContain(
      "Error in tool 'sampleFunction'",
    );
  });

  it('evaluates requireConfirmation before resolving credentials', async () => {
    const execute = vi.fn(sampleFunction);
    const tool = new GoogleTool({
      name: 'confirmedGoogleTool',
      description: 'Requires confirmation',
      parameters: sampleParameters,
      execute,
      credentialsConfig,
      requireConfirmation: true,
    });
    const getCredsSpy = vi.spyOn(
      tool.credentialsManager as GoogleCredentialsManager,
      'getValidCredentials',
    );
    const toolContext = createMockToolContext();

    const result = await tool.runAsync({
      args: {param1: 'testValue'},
      toolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(toolContext.requestConfirmation).toHaveBeenCalledOnce();
    expect(getCredsSpy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('strips credentials and settings from _getDeclaration without mutating base schemas', () => {
    const zodTool = new GoogleTool({
      name: 'zodGoogleTool',
      description: 'Zod Google tool',
      parameters: z.object({
        requiredParam: z.string(),
        optionalParam: z.string().optional(),
        credentials: z.string(),
        settings: z.string(),
      }),
      execute: () => ({ok: true}),
      credentialsConfig,
    });

    const zodDecl = zodTool._getDeclaration();
    expect(zodDecl.parameters?.required).toEqual(['requiredParam']);
    expect(zodDecl.parameters?.properties?.['credentials']).toBeUndefined();
    expect(zodDecl.parameters?.properties?.['settings']).toBeUndefined();
    expect(zodDecl.parameters?.properties?.['requiredParam']).toBeDefined();
    expect(zodDecl.parameters?.properties?.['optionalParam']).toBeDefined();

    const baseSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        query: {type: Type.STRING},
        credentials: {type: Type.OBJECT},
        settings: {type: Type.OBJECT},
      },
      required: ['query', 'credentials', 'settings'],
    };
    const schemaTool = new GoogleTool({
      name: 'schemaGoogleTool',
      description: 'Genai Schema Google tool',
      parameters: baseSchema,
      execute: () => ({ok: true}),
    });

    const schemaDecl = schemaTool._getDeclaration();
    expect(schemaDecl.parameters?.required).toEqual(['query']);
    expect(schemaDecl.parameters?.properties?.['credentials']).toBeUndefined();
    expect(schemaDecl.parameters?.properties?.['settings']).toBeUndefined();
    expect(baseSchema.properties?.['credentials']).toBeDefined();
    expect(baseSchema.properties?.['settings']).toBeDefined();
    expect(baseSchema.required).toEqual(['query', 'credentials', 'settings']);
  });

  it('overwrites model-supplied credentials and settings and passes resolved values to subclasses', async () => {
    const trustedSettings: SampleSettings = {maxResults: 5};
    const tool = createSampleTool(undefined, trustedSettings);

    const directResult = await tool.runAsync({
      args: {
        param1: 'val',
        credentials: {token: 'forged'},
        settings: {maxResults: 999},
      },
      toolContext: createMockToolContext(),
    });
    expect(directResult).toEqual({
      result: 'Success with val',
      authenticated: false,
      maxResults: 5,
    });

    const confirmationSpy = vi.fn(() => false);
    const untypedTool = new GoogleTool<ToolInputParameters, SampleSettings>({
      name: 'untypedGoogleTool',
      description: 'Untyped tool strips forged args before confirmation',
      execute: (args) =>
        sampleFunction({
          param1: String(args['param1']),
          credentials: args.credentials,
          settings: args.settings,
        }),
      toolSettings: trustedSettings,
      requireConfirmation: confirmationSpy,
    });
    const untypedResult = await untypedTool.runAsync({
      args: {
        param1: 'untypedVal',
        credentials: {token: 'forged'},
        settings: {maxResults: 999},
      },
      toolContext: createMockToolContext(),
    });
    expect(confirmationSpy).toHaveBeenCalledWith(
      {param1: 'untypedVal'},
      expect.anything(),
    );
    expect(untypedResult).toEqual({
      result: 'Success with untypedVal',
      authenticated: false,
      maxResults: 5,
    });

    class CustomGoogleTool extends GoogleTool<
      typeof sampleParameters,
      SampleSettings
    > {
      override async runAsyncWithCredential(
        request: RunAsyncWithCredentialRequest<
          typeof sampleParameters,
          SampleSettings
        >,
      ): Promise<unknown> {
        return {
          argParam: request.args.param1,
          hasCreds: request.credentials !== undefined,
          maxResults: request.toolSettings?.maxResults,
        };
      }
    }

    const customTool = new CustomGoogleTool({
      name: 'customGoogleTool',
      description: 'Subclass override test',
      parameters: sampleParameters,
      execute: sampleFunction,
      credentialsConfig,
      toolSettings: trustedSettings,
    });
    vi.spyOn(
      customTool.credentialsManager as GoogleCredentialsManager,
      'getValidCredentials',
    ).mockResolvedValue({valid: true, token: 'tok'});

    expect(
      await customTool.runAsync({
        args: {param1: 'subVal'},
        toolContext: createMockToolContext(),
      }),
    ).toEqual({
      argParam: 'subVal',
      hasCreds: true,
      maxResults: 5,
    });
  });

  it('strips forged credentials and settings in checkRequireConfirmation and during confirmation resume', async () => {
    const seenPredicateArgs: Array<Record<string, unknown>> = [];
    const executedInputs: Array<{
      param1: unknown;
      credentials: GoogleCredentials | undefined;
      settings: SampleSettings | undefined;
    }> = [];
    const trustedSettings: SampleSettings = {maxResults: 5};

    const tool = new GoogleTool<ToolInputParameters, SampleSettings>({
      name: 'gatedUntypedTool',
      description: 'Untyped gated Google tool',
      toolSettings: trustedSettings,
      requireConfirmation: (args) => {
        const record =
          typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)
            : {};
        seenPredicateArgs.push(record);
        return (
          !('credentials' in record) &&
          !('settings' in record) &&
          record['param1'] === 'sensitive'
        );
      },
      execute: (input) => {
        executedInputs.push({
          param1: input['param1'],
          credentials: input.credentials,
          settings: input.settings,
        });
        return {ok: true, maxResults: input.settings?.maxResults};
      },
    });

    await expect(
      tool.checkRequireConfirmation({
        param1: 'sensitive',
        credentials: {token: 'forged'},
        settings: {maxResults: 999},
      }),
    ).resolves.toBe(true);
    expect(seenPredicateArgs).toEqual([{param1: 'sensitive'}]);

    class ConfirmationResumeLlm extends BaseLlm {
      private turn = 0;

      constructor() {
        super({model: 'gemini-flash-latest'});
      }

      override async *generateContentAsync(
        _llmRequest: LlmRequest,
      ): AsyncGenerator<LlmResponse, void, void> {
        this.turn += 1;
        if (this.turn === 1) {
          yield {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call-gated-1',
                    name: 'gatedUntypedTool',
                    args: {
                      param1: 'sensitive',
                      credentials: {token: 'forged'},
                      settings: {maxResults: 999},
                    },
                  },
                },
              ],
            },
          };
          return;
        }
        yield {
          content: {
            role: 'model',
            parts: [{text: 'Confirmed and completed'}],
          },
        };
      }

      override async connect(): Promise<BaseLlmConnection> {
        throw new Error('Live connection not used');
      }
    }

    const runner = new InMemoryRunner({
      agent: new LlmAgent({
        name: 'gatedGoogleAgent',
        model: new ConfirmationResumeLlm(),
        tools: [tool],
      }),
      appName: 'gatedGoogleApp',
    });
    const session = await runner.sessionService.createSession({
      appName: 'gatedGoogleApp',
      userId: 'user-1',
    });

    const firstTurnEvents = [];
    const userPrompt: Content = {
      role: 'user',
      parts: [{text: 'Run gated tool'}],
    };
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: userPrompt,
    })) {
      firstTurnEvents.push(event);
    }

    const gateEvent = firstTurnEvents.at(-1);
    const confirmationCall = gateEvent
      ? getFunctionCalls(gateEvent)[0]
      : undefined;
    expect(confirmationCall?.name).toBe(
      REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
    );
    expect(confirmationCall?.id).toBeDefined();
    expect(executedInputs).toEqual([]);

    const resumedEvents = [];
    const approvalMessage: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: confirmationCall?.id,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: {confirmed: true},
          },
        },
      ],
    };
    for await (const event of runner.runAsync({
      userId: 'user-1',
      sessionId: session.id,
      newMessage: approvalMessage,
    })) {
      resumedEvents.push(event);
    }

    expect(executedInputs).toEqual([
      {
        param1: 'sensitive',
        credentials: undefined,
        settings: {maxResults: 5},
      },
    ]);
    expect(seenPredicateArgs).toEqual([
      {param1: 'sensitive'},
      {param1: 'sensitive'},
      {param1: 'sensitive'},
      {param1: 'sensitive'},
    ]);
    expect(resumedEvents.at(-1)?.content?.parts?.[0]?.text).toBe(
      'Confirmed and completed',
    );
  });
});
