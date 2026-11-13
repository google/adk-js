/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthenticatedFunctionTool,
  AuthSchemeType,
  Context,
  CredentialManager,
  functionsExportedForTestingOnly,
  InvocationContext,
  isAuthenticatedFunctionTool,
  isFunctionTool,
  LlmAgent,
  PluginManager,
  Session,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

const twoArgSchema = z.object({
  arg1: z.string(),
  arg2: z.number(),
});

const singleArgSchema = z.object({
  arg1: z.string(),
});

const optionalArgSchema = z.object({
  arg1: z.string(),
  arg2: z.string().default('default'),
});

function syncFunctionNoCredential({
  arg1,
  arg2,
}: {
  arg1: string;
  arg2: number;
}): string {
  return `sync_result_${arg1}_${arg2}`;
}

async function asyncFunctionNoCredential({
  arg1,
  arg2,
}: {
  arg1: string;
  arg2: number;
}): Promise<string> {
  return `async_result_${arg1}_${arg2}`;
}

function syncFunctionWithCredential(
  {arg1}: {arg1: string},
  _toolContext?: Context,
  credential?: AuthCredential,
): string {
  return `sync_cred_result_${arg1}_${credential?.authType}`;
}

async function asyncFunctionWithCredential(
  {arg1}: {arg1: string},
  _toolContext?: Context,
  credential?: AuthCredential,
): Promise<string> {
  return `async_cred_result_${arg1}_${credential?.authType}`;
}

function syncFunctionWithToolContext(
  {arg1}: {arg1: string},
  toolContext?: Context,
): string {
  expect(toolContext).toBeDefined();
  return `sync_context_result_${arg1}`;
}

async function asyncFunctionWithBoth(
  {arg1}: {arg1: string},
  toolContext?: Context,
  credential?: AuthCredential,
): Promise<string> {
  expect(toolContext).toBeDefined();
  return `async_both_result_${arg1}_${credential?.authType}`;
}

function functionWithOptionalArgs(
  {arg1, arg2}: {arg1: string; arg2: string},
  _toolContext?: Context,
  credential?: AuthCredential,
): string {
  const credType = credential ? credential.authType : 'none';
  return `optional_result_${arg1}_${arg2}_${credType}`;
}

class AuthenticatedHandler {
  execute(
    {arg1}: {arg1: string},
    _toolContext?: Context,
    credential?: AuthCredential,
  ): string {
    return `handler_result_${arg1}_${credential?.authType}`;
  }
}

function createTestAuthConfig(): AuthConfig {
  return {
    authScheme: {
      type: AuthSchemeType.HTTP,
      scheme: 'bearer',
    },
    credentialKey: 'test-credential-key',
  };
}

function createTestAuthCredential(): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      accessToken: 'token-1',
    },
  };
}

function createTestInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv_auth_func_tool_test',
    session: {} as Session,
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-flash-latest'}),
    pluginManager: new PluginManager(),
  });
}

describe('AuthenticatedFunctionTool', () => {
  describe('isAuthenticatedFunctionTool', () => {
    it('identifies AuthenticatedFunctionTool instances and preserves FunctionTool brand', () => {
      const tool = new AuthenticatedFunctionTool({
        description: 'Test tool',
        parameters: twoArgSchema,
        execute: syncFunctionNoCredential,
      });
      expect(isAuthenticatedFunctionTool(tool)).toBe(true);
      expect(isFunctionTool(tool)).toBe(true);
      expect(isAuthenticatedFunctionTool({})).toBe(false);
      expect(isAuthenticatedFunctionTool(null)).toBe(false);
      expect(isAuthenticatedFunctionTool(undefined)).toBe(false);
    });
  });

  it('initializes with synchronous, asynchronous, and bound handler functions', () => {
    const authConfig = createTestAuthConfig();

    const syncTool = new AuthenticatedFunctionTool({
      description: 'Test sync function without credential parameter.',
      parameters: twoArgSchema,
      execute: syncFunctionNoCredential,
      authConfig,
      responseForAuthRequired: 'Please authenticate',
    });

    expect(syncTool.name).toBe('syncFunctionNoCredential');
    expect(syncTool.description).toBe(
      'Test sync function without credential parameter.',
    );

    const asyncTool = new AuthenticatedFunctionTool({
      description: 'Test async function without credential parameter.',
      parameters: twoArgSchema,
      execute: asyncFunctionNoCredential,
      authConfig,
    });

    expect(asyncTool.name).toBe('asyncFunctionNoCredential');
    expect(asyncTool.description).toBe(
      'Test async function without credential parameter.',
    );

    const handler = new AuthenticatedHandler();
    const handlerTool = new AuthenticatedFunctionTool({
      name: 'AuthenticatedHandler',
      description: 'Test handler documentation',
      parameters: singleArgSchema,
      execute: handler.execute.bind(handler),
      authConfig,
    });

    expect(handlerTool.name).toBe('AuthenticatedHandler');
    expect(handlerTool.description).toBe('Test handler documentation');
  });

  it('executes synchronous and asynchronous functions when no authConfig or authScheme is configured', async () => {
    const syncTool = new AuthenticatedFunctionTool({
      description: 'Sync tool without authConfig.',
      parameters: twoArgSchema,
      execute: syncFunctionNoCredential,
    });
    const toolContext = {} as Context;
    const args = {arg1: 'test', arg2: 42};

    expect(await syncTool.runAsync({args, toolContext})).toBe(
      'sync_result_test_42',
    );

    const emptySchemeAuthConfig = {
      credentialKey: 'key-1',
    } as unknown as AuthConfig;
    const asyncTool = new AuthenticatedFunctionTool({
      description: 'Async tool with empty authScheme.',
      parameters: twoArgSchema,
      execute: asyncFunctionNoCredential,
      authConfig: emptySchemeAuthConfig,
    });

    expect(await asyncTool.runAsync({args, toolContext})).toBe(
      'async_result_test_42',
    );
  });

  it('resolves credential from CredentialManager and passes it to synchronous, asynchronous, and bound handler functions', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const toolContext = {} as Context;
      const args = {arg1: 'test'};

      const syncTool = new AuthenticatedFunctionTool({
        description: 'Sync function with credential.',
        parameters: singleArgSchema,
        execute: syncFunctionWithCredential,
        authConfig,
      });
      expect(await syncTool.runAsync({args, toolContext})).toBe(
        `sync_cred_result_test_${credential.authType}`,
      );
      expect(getAuthCredentialSpy).toHaveBeenCalledWith(toolContext);

      const asyncTool = new AuthenticatedFunctionTool({
        description: 'Async function with credential.',
        parameters: singleArgSchema,
        execute: asyncFunctionWithCredential,
        authConfig,
      });
      expect(await asyncTool.runAsync({args, toolContext})).toBe(
        `async_cred_result_test_${credential.authType}`,
      );

      const handler = new AuthenticatedHandler();
      const handlerTool = new AuthenticatedFunctionTool({
        name: 'AuthenticatedHandler',
        description: 'Bound handler with credential.',
        parameters: singleArgSchema,
        execute: handler.execute.bind(handler),
        authConfig,
      });
      expect(await handlerTool.runAsync({args, toolContext})).toBe(
        `handler_result_test_${credential.authType}`,
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('requests credential and returns custom responseForAuthRequired when no credential is available', async () => {
    const authConfig = createTestAuthConfig();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(undefined);
    const requestCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'requestCredential')
      .mockResolvedValue();

    try {
      const tool = new AuthenticatedFunctionTool({
        description: 'Sync function with custom pending message.',
        parameters: singleArgSchema,
        execute: syncFunctionWithCredential,
        authConfig,
        responseForAuthRequired: 'Custom auth required',
      });

      const toolContext = {} as Context;
      const result = await tool.runAsync({args: {arg1: 'test'}, toolContext});

      expect(result).toBe('Custom auth required');
      expect(getAuthCredentialSpy).toHaveBeenCalledOnce();
      expect(getAuthCredentialSpy).toHaveBeenCalledWith(toolContext);
      expect(requestCredentialSpy).toHaveBeenCalledOnce();
      expect(requestCredentialSpy).toHaveBeenCalledWith(toolContext);
    } finally {
      getAuthCredentialSpy.mockRestore();
      requestCredentialSpy.mockRestore();
    }
  });

  it('requests credential and returns default pending message when no credential is available', async () => {
    const authConfig = createTestAuthConfig();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(undefined);
    const requestCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'requestCredential')
      .mockResolvedValue();

    try {
      const tool = new AuthenticatedFunctionTool({
        description: 'Sync function with default pending message.',
        parameters: singleArgSchema,
        execute: syncFunctionWithCredential,
        authConfig,
      });

      const toolContext = {} as Context;
      const result = await tool.runAsync({args: {arg1: 'test'}, toolContext});

      expect(result).toBe('Pending User Authorization.');
      expect(requestCredentialSpy).toHaveBeenCalledOnce();
    } finally {
      getAuthCredentialSpy.mockRestore();
      requestCredentialSpy.mockRestore();
    }
  });

  it('executes function that does not read the credential parameter', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const tool = new AuthenticatedFunctionTool({
        description: 'Function ignoring credential.',
        parameters: twoArgSchema,
        execute: syncFunctionNoCredential,
        authConfig,
      });

      const toolContext = {} as Context;
      const result = await tool.runAsync({
        args: {arg1: 'test', arg2: 42},
        toolContext,
      });

      expect(result).toBe('sync_result_test_42');
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('passes toolContext and credential to execute', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const toolContext = {} as Context;
      const args = {arg1: 'test'};

      const contextOnlyTool = new AuthenticatedFunctionTool({
        description: 'Function with toolContext.',
        parameters: singleArgSchema,
        execute: syncFunctionWithToolContext,
        authConfig,
      });
      expect(await contextOnlyTool.runAsync({args, toolContext})).toBe(
        'sync_context_result_test',
      );

      const bothTool = new AuthenticatedFunctionTool({
        description: 'Function with toolContext and credential.',
        parameters: singleArgSchema,
        execute: asyncFunctionWithBoth,
        authConfig,
      });
      expect(await bothTool.runAsync({args, toolContext})).toBe(
        `async_both_result_test_${credential.authType}`,
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('applies default parameter values with resolved or undefined credential', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const toolContext = {} as Context;
      const args = {arg1: 'test'};

      const authedTool = new AuthenticatedFunctionTool({
        description: 'Function with optional args and credential.',
        parameters: optionalArgSchema,
        execute: functionWithOptionalArgs,
        authConfig,
      });
      expect(await authedTool.runAsync({args, toolContext})).toBe(
        `optional_result_test_default_${credential.authType}`,
      );

      const unauthedTool = new AuthenticatedFunctionTool({
        description: 'Function with optional args and no authConfig.',
        parameters: optionalArgSchema,
        execute: functionWithOptionalArgs,
      });
      expect(await unauthedTool.runAsync({args, toolContext})).toBe(
        'optional_result_test_default_none',
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('propagates errors thrown by the wrapped function', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const tool = new AuthenticatedFunctionTool({
        name: 'failingFunction',
        description: 'Function that fails.',
        parameters: singleArgSchema,
        execute: () => {
          throw new Error('Function failed');
        },
        authConfig,
      });

      await expect(
        tool.runAsync({args: {arg1: 'test'}, toolContext: {} as Context}),
      ).rejects.toThrow("Error in tool 'failingFunction': Function failed");
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('rejects missing required parameters and surfaces an error response via handleFunctionCallList', async () => {
    const {handleFunctionCallList} = functionsExportedForTestingOnly;
    const tool = new AuthenticatedFunctionTool({
      name: 'sync_function_no_credential',
      description: 'Requires two arguments.',
      parameters: twoArgSchema,
      execute: syncFunctionNoCredential,
    });

    const args = {arg1: 'test'};
    await expect(
      tool.runAsync({args, toolContext: {} as Context}),
    ).rejects.toThrow(
      /Error in tool 'sync_function_no_credential':[\s\S]*arg2/,
    );

    const event = await handleFunctionCallList({
      invocationContext: createTestInvocationContext(),
      functionCalls: [{id: 'call-1', name: tool.name, args}],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    expect(event?.content?.parts?.[0]?.functionResponse?.response).toEqual({
      error: expect.stringMatching(
        /Error in tool 'sync_function_no_credential':[\s\S]*arg2/,
      ),
    });
  });

  it('propagates errors thrown by CredentialManager.getAuthCredential', async () => {
    const authConfig = createTestAuthConfig();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockRejectedValue(new Error('Credential service error'));

    try {
      const tool = new AuthenticatedFunctionTool({
        description: 'Function when credential manager throws.',
        parameters: singleArgSchema,
        execute: syncFunctionWithCredential,
        authConfig,
      });

      await expect(
        tool.runAsync({args: {arg1: 'test'}, toolContext: {} as Context}),
      ).rejects.toThrow('Credential service error');
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('omits credential from the generated FunctionDeclaration parameters schema', () => {
    const toolWithZod = new AuthenticatedFunctionTool({
      name: 'authed_query',
      description: 'Queries protected endpoint.',
      parameters: z.object({
        arg1: z.string(),
        credential: z.string().optional(),
      }),
      execute: syncFunctionWithCredential,
    });

    const declaration = toolWithZod._getDeclaration();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        arg1: {type: Type.STRING},
      },
      required: ['arg1'],
    });

    const toolWithRawSchema = new AuthenticatedFunctionTool({
      name: 'authed_raw_schema',
      description: 'Uses a raw Schema containing credential.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          arg1: {type: Type.STRING},
          credential: {type: Type.OBJECT},
        },
        required: ['arg1', 'credential'],
      },
      execute: (
        input: unknown,
        _toolContext?: Context,
        cred?: AuthCredential,
      ) => `${String((input as {arg1?: string})?.arg1)}_${cred?.authType}`,
    });

    expect(toolWithRawSchema._getDeclaration().parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        arg1: {type: Type.STRING},
      },
      required: ['arg1'],
    });
  });

  it('passes resolved credential to execute without mutating the caller args object', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      let capturedArgs: {arg1: string} | undefined;
      let capturedCredential: AuthCredential | undefined;

      const tool = new AuthenticatedFunctionTool({
        name: 'spy_function',
        description: 'Captures input and credential.',
        parameters: singleArgSchema.strict(),
        execute: (input, _toolContext, cred) => {
          capturedArgs = input;
          capturedCredential = cred;
          return 'spy_result';
        },
        authConfig,
      });

      const callerArgs = {arg1: 'test'};
      const result = await tool.runAsync({
        args: callerArgs,
        toolContext: {} as Context,
      });

      expect(result).toBe('spy_result');
      expect(callerArgs).toEqual({arg1: 'test'});
      expect(capturedArgs).toEqual({arg1: 'test'});
      expect(capturedCredential).toBe(credential);
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('enforces requireConfirmation after credential resolution through super.runAsync', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const executeSpy = vi.fn().mockReturnValue('executed');
      const tool = new AuthenticatedFunctionTool({
        name: 'gated_authed_tool',
        description: 'Requires confirmation and authentication.',
        parameters: singleArgSchema,
        requireConfirmation: true,
        authConfig,
        execute: executeSpy,
      });

      const requestConfirmation = vi.fn();
      const unconfirmedContext = {
        requestConfirmation,
        actions: {},
      } as unknown as Context;

      const pendingResult = await tool.runAsync({
        args: {arg1: 'test'},
        toolContext: unconfirmedContext,
      });

      expect(pendingResult).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(requestConfirmation).toHaveBeenCalledOnce();
      expect(executeSpy).not.toHaveBeenCalled();

      const confirmedContext = {
        toolConfirmation: {confirmed: true},
        actions: {},
      } as unknown as Context;

      const confirmedResult = await tool.runAsync({
        args: {arg1: 'test'},
        toolContext: confirmedContext,
      });

      expect(confirmedResult).toBe('executed');
      expect(executeSpy).toHaveBeenCalledWith(
        {arg1: 'test'},
        confirmedContext,
        credential,
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('isolates resolved credentials across concurrent invocations with different toolContext instances', async () => {
    const authConfig = createTestAuthConfig();
    const credentialA: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token-a'},
    };
    const credentialB: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token-b'},
    };
    const contextA = {actions: {}} as unknown as Context;
    const contextB = {actions: {}} as unknown as Context;

    let releaseFirstConfirmation: (() => void) | undefined;
    const firstConfirmationGate = new Promise<void>((resolve) => {
      releaseFirstConfirmation = resolve;
    });

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockImplementation(async (ctx) =>
        ctx === contextA ? credentialA : credentialB,
      );

    try {
      const tool = new AuthenticatedFunctionTool({
        name: 'concurrent_authed_tool',
        description: 'Handles concurrent authenticated calls.',
        parameters: singleArgSchema,
        requireConfirmation: async ({arg1}) => {
          if (arg1 === 'first') {
            await firstConfirmationGate;
          }
          return false;
        },
        authConfig,
        execute: ({arg1}, _toolContext, cred) =>
          `${arg1}:${cred?.oauth2?.accessToken}`,
      });

      const firstPromise = tool.runAsync({
        args: {arg1: 'first'},
        toolContext: contextA,
      });
      const secondResult = await tool.runAsync({
        args: {arg1: 'second'},
        toolContext: contextB,
      });
      releaseFirstConfirmation?.();
      const firstResult = await firstPromise;

      expect(firstResult).toBe('first:token-a');
      expect(secondResult).toBe('second:token-b');
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('keeps each credential when overlapping calls share one toolContext', async () => {
    const authConfig = createTestAuthConfig();
    const credentialA: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token-a'},
    };
    const credentialB: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token-b'},
    };
    const sharedContext = {actions: {}} as unknown as Context;

    let releaseSecondConfirmation: (() => void) | undefined;
    const secondConfirmationGate = new Promise<void>((resolve) => {
      releaseSecondConfirmation = resolve;
    });

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValueOnce(credentialA)
      .mockResolvedValueOnce(credentialB);

    try {
      const tool = new AuthenticatedFunctionTool({
        name: 'shared_context_authed_tool',
        description: 'Handles overlapping calls on one tool context.',
        parameters: singleArgSchema,
        requireConfirmation: async ({arg1}) => {
          if (arg1 === 'second') {
            await secondConfirmationGate;
          }
          return false;
        },
        authConfig,
        execute: ({arg1}, _toolContext, cred) =>
          `${arg1}:${cred?.oauth2?.accessToken}`,
      });

      const results = Promise.all([
        tool.runAsync({args: {arg1: 'first'}, toolContext: sharedContext}),
        tool.runAsync({args: {arg1: 'second'}, toolContext: sharedContext}),
      ]);
      // Let the first call finish while the second waits on its gate.
      await vi.waitFor(() =>
        expect(getAuthCredentialSpy).toHaveBeenCalledTimes(2),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseSecondConfirmation?.();

      expect(await results).toEqual(['first:token-a', 'second:token-b']);
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('does not require a credential declared in a Zod parameters schema', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const tool = new AuthenticatedFunctionTool({
        name: 'zod_credential_tool',
        description: 'Declares credential in its Zod schema.',
        parameters: z
          .object({
            arg1: z.string(),
            credential: z.string(),
          })
          .strict(),
        execute: syncFunctionWithCredential,
        authConfig,
      });

      expect(
        await tool.runAsync({args: {arg1: 'test'}, toolContext: {} as Context}),
      ).toBe(`sync_cred_result_test_${credential.authType}`);
      expect(tool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {
          arg1: {type: Type.STRING},
        },
        required: ['arg1'],
      });
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('throws when neither name nor a named execute function is provided', () => {
    const anonymousFunctions = [() => 'result'];

    expect(
      () =>
        new AuthenticatedFunctionTool({
          description: 'Anonymous tool.',
          execute: anonymousFunctions[0],
        }),
    ).toThrow('Tool name cannot be empty');
  });
});
