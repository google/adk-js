/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Context,
  FunctionTool,
  GoogleCredentialsManager,
  isFunctionTool,
  isGoogleCredentialsManager,
  isGoogleTool,
  State,
} from '@google/adk';
import {
  type BigQueryCredentials,
  BigQueryCredentialsConfig,
  BigQueryTool,
  BigQueryToolConfig,
  type GoogleOAuthCredentials,
  isBigQueryTool,
  WriteMode,
} from '@google/adk-integrations';
import {type Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

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
  credentials?: BigQueryCredentials;
}): {result: string; authenticated: boolean} {
  return {
    result: `Success with ${args.param1}`,
    authenticated: args.credentials !== undefined,
  };
}

async function asyncSampleFunction(args: {
  param1: string;
  credentials?: BigQueryCredentials;
}): Promise<{result: string; authenticated: boolean}> {
  return {
    result: `Async success with ${args.param1}`,
    authenticated: args.credentials !== undefined,
  };
}

describe('BigQueryTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const credentialsConfig = new BigQueryCredentialsConfig({
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    scopes: ['https://www.googleapis.com/auth/bigquery'],
  });

  function createSampleTool(
    config?: BigQueryCredentialsConfig,
  ): BigQueryTool<typeof sampleParameters> {
    return new BigQueryTool({
      description: 'Sample tool',
      parameters: sampleParameters,
      execute: sampleFunction,
      credentialsConfig: config,
    });
  }

  function getCredentialsManager(tool: BigQueryTool): GoogleCredentialsManager {
    if (!tool.credentialsManager) {
      throw new Error('Expected credentialsManager on tool');
    }
    return tool.credentialsManager;
  }

  it('identifies BigQueryTool instances via isBigQueryTool', () => {
    const tool = createSampleTool(credentialsConfig);
    const fnTool = new FunctionTool({
      name: 'plain_fn',
      description: 'Plain function tool',
      execute: () => 'ok',
    });

    expect(isBigQueryTool(tool)).toBe(true);
    expect(isGoogleTool(tool)).toBe(true);
    expect(isFunctionTool(tool)).toBe(true);
    expect(isBigQueryTool(fnTool)).toBe(false);
    expect(isBigQueryTool({})).toBe(false);
    expect(isBigQueryTool(null)).toBe(false);
  });

  it('creates a credentials manager when credentialsConfig is given', () => {
    const tool = createSampleTool(credentialsConfig);

    expect(tool.name).toBe('sampleFunction');
    expect(isGoogleCredentialsManager(tool.credentialsManager)).toBe(true);
    expect(tool.credentialsManager).toBeInstanceOf(GoogleCredentialsManager);
    expect(tool.ignoreParams).toContain('credentials');
    expect(tool.ignoreParams).toContain('config');
    expect(tool.ignoreParams).toContain('settings');
  });

  it('has no credentials manager when credentialsConfig is omitted', () => {
    const tool = createSampleTool();

    expect(tool.name).toBe('sampleFunction');
    expect(tool.credentialsManager).toBeUndefined();
  });

  it('rejects an anonymous execute function without a name', () => {
    expect(
      () =>
        new BigQueryTool({
          description: 'Anonymous tool',
          execute: (
            () => () =>
              'ok'
          )(),
        }),
    ).toThrow(/Tool name cannot be empty/);
  });

  it('passes resolved credentials to execute', async () => {
    const tool = createSampleTool(credentialsConfig);
    const mockToolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(getCredentialsManager(tool), 'getValidCredentials')
      .mockResolvedValue(mockCreds);

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    });

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(mockToolContext);
    expect(result).toEqual({
      result: 'Success with test_value',
      authenticated: true,
    });
  });

  it('returns an authorization message while the OAuth2 flow is pending', async () => {
    const execute = vi.fn(sampleFunction);
    const tool = new BigQueryTool({
      name: 'sample_tool',
      description: 'Sample tool',
      parameters: sampleParameters,
      execute,
      credentialsConfig,
    });
    const mockToolContext = createMockToolContext();

    const getCredsSpy = vi
      .spyOn(getCredentialsManager(tool), 'getValidCredentials')
      .mockResolvedValue(undefined);

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as string;

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(mockToolContext);
    expect(result.toLowerCase()).toContain('authorization is required');
    expect(result).toContain('sample_tool');
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes undefined credentials when no credentials manager exists', async () => {
    const tool = createSampleTool();

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      result: 'Success with test_value',
      authenticated: false,
    });
  });

  it('ignores credentials supplied in the model arguments', async () => {
    const tool = createSampleTool();

    const result = await tool.runAsync({
      args: {param1: 'test_value', credentials: {token: 'from-model'}},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      result: 'Success with test_value',
      authenticated: false,
    });
  });

  it('awaits an async execute function', async () => {
    const tool = new BigQueryTool({
      description: 'Async sample tool',
      parameters: sampleParameters,
      execute: asyncSampleFunction,
      credentialsConfig,
    });
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};
    vi.spyOn(
      getCredentialsManager(tool),
      'getValidCredentials',
    ).mockResolvedValue(mockCreds);

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      result: 'Async success with test_value',
      authenticated: true,
    });
  });

  it('returns a structured error when execute throws', async () => {
    function failingFunction(): never {
      throw new Error('Something went wrong');
    }

    const tool = new BigQueryTool({
      description: 'Failing tool',
      execute: failingFunction,
      credentialsConfig,
    });
    vi.spyOn(
      getCredentialsManager(tool),
      'getValidCredentials',
    ).mockResolvedValue({valid: true, token: 'tok'});

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Something went wrong',
    });
  });

  it('returns a structured error when a plain object is thrown', async () => {
    const tool = new BigQueryTool({
      name: 'object_thrower',
      description: 'Throws a plain object',
      execute: () => {
        throw {code: 403, reason: 'accessDenied'};
      },
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: '{"code":403,"reason":"accessDenied"}',
    });
  });

  it('returns a structured error when credential resolution throws', async () => {
    const tool = createSampleTool(credentialsConfig);
    vi.spyOn(
      getCredentialsManager(tool),
      'getValidCredentials',
    ).mockRejectedValue(new Error('No access token found'));

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'No access token found',
    });
  });

  it('returns a structured error when arguments fail validation', async () => {
    const tool = createSampleTool();

    const result = (await tool.runAsync({
      args: {param1: 42},
      toolContext: createMockToolContext(),
    })) as {status: string; error_details: string};

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain("Error in tool 'sampleFunction'");
  });

  it('asks for confirmation before resolving credentials when requireConfirmation is set', async () => {
    const execute = vi.fn(sampleFunction);
    const tool = new BigQueryTool({
      name: 'confirmed_tool',
      description: 'Tool gated on confirmation',
      parameters: sampleParameters,
      execute,
      credentialsConfig,
      requireConfirmation: true,
    });
    const getCredsSpy = vi.spyOn(
      getCredentialsManager(tool),
      'getValidCredentials',
    );
    const mockToolContext = createMockToolContext();

    const result = await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(mockToolContext.requestConfirmation).toHaveBeenCalledOnce();
    expect(getCredsSpy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('omits credentials, config, and settings from the function declaration', () => {
    const tool = new BigQueryTool({
      name: 'complex_function',
      description:
        'A tool with required, optional, credentials, config, and settings parameters',
      parameters: z.object({
        requiredParam: z.string(),
        optionalParam: z.string().optional(),
        credentials: z.unknown(),
        config: z.unknown(),
        settings: z.unknown(),
      }),
      execute: () => ({success: true}),
      credentialsConfig,
    });

    const declaration = tool._getDeclaration();
    const requiredArgs = declaration.parameters?.required ?? [];
    const properties = declaration.parameters?.properties ?? {};

    expect(requiredArgs).toEqual(['requiredParam']);
    expect(properties['credentials']).toBeUndefined();
    expect(properties['config']).toBeUndefined();
    expect(properties['settings']).toBeUndefined();
    expect(properties['requiredParam']).toBeDefined();
    expect(properties['optionalParam']).toBeDefined();

    const baseSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        query: {type: Type.STRING},
        credentials: {type: Type.OBJECT},
        config: {type: Type.OBJECT},
        settings: {type: Type.OBJECT},
      },
      required: ['query', 'credentials', 'config', 'settings'],
    };
    const schemaTool = new BigQueryTool({
      name: 'schemaComplexFunction',
      description: 'Schema-backed tool',
      parameters: baseSchema,
      execute: () => ({success: true}),
    });
    const schemaDecl = schemaTool._getDeclaration();
    expect(schemaDecl.parameters?.required).toEqual(['query']);
    expect(schemaDecl.parameters?.properties?.['credentials']).toBeUndefined();
    expect(schemaDecl.parameters?.properties?.['config']).toBeUndefined();
    expect(schemaDecl.parameters?.properties?.['settings']).toBeUndefined();
    expect(baseSchema.required).toEqual([
      'query',
      'credentials',
      'config',
      'settings',
    ]);
  });

  it('forwards toolConfig to both config and settings in execute', async () => {
    const customConfig = new BigQueryToolConfig({
      writeMode: WriteMode.ALLOWED,
    });
    let receivedConfig: BigQueryToolConfig | undefined;
    let receivedSettings: BigQueryToolConfig | undefined;
    const tool = new BigQueryTool({
      name: 'config_tool',
      description: 'Tool accepting config and settings',
      parameters: sampleParameters,
      toolConfig: customConfig,
      execute: ({param1, config, settings}) => {
        receivedConfig = config;
        receivedSettings = settings;
        return {result: `Processed ${param1}`};
      },
    });

    const result = await tool.runAsync({
      args: {param1: 'val'},
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({result: 'Processed val'});
    expect(receivedConfig).toBe(customConfig);
    expect(receivedSettings).toBe(customConfig);
    expect(receivedConfig?.writeMode).toBe(WriteMode.ALLOWED);
  });

  it('ignores config and settings supplied in the model arguments', async () => {
    const customConfig = new BigQueryToolConfig({
      writeMode: WriteMode.BLOCKED,
    });
    let receivedConfig: BigQueryToolConfig | undefined;
    let receivedSettings: BigQueryToolConfig | undefined;
    const tool = new BigQueryTool({
      name: 'config_override_tool',
      description: 'Tool testing model argument override protection',
      parameters: z.object({
        param1: z.string(),
        config: z.unknown(),
        settings: z.unknown(),
      }),
      toolConfig: customConfig,
      execute: ({param1, config, settings}) => {
        receivedConfig = config;
        receivedSettings = settings;
        return {result: `Processed ${param1}`};
      },
    });

    const result = await tool.runAsync({
      args: {
        param1: 'val',
        config: {writeMode: 'allowed'},
        settings: {writeMode: 'allowed'},
      },
      toolContext: createMockToolContext(),
    });

    expect(result).toEqual({result: 'Processed val'});
    expect(receivedConfig).toBe(customConfig);
    expect(receivedSettings).toBe(customConfig);
    expect(receivedConfig?.writeMode).toBe(WriteMode.BLOCKED);
  });

  it('strips credentials, config, and settings before evaluating requireConfirmation', async () => {
    const seenArgs: Array<{param1: string}> = [];
    const tool = new BigQueryTool({
      name: 'confirmedLegacyTool',
      description: 'Legacy tool with requireConfirmation',
      parameters: sampleParameters,
      requireConfirmation: (args) => {
        seenArgs.push(args);
        return args.param1 === 'confirm';
      },
      execute: sampleFunction,
    });

    await expect(
      tool.checkRequireConfirmation({
        param1: 'confirm',
        credentials: {token: 'forged'},
        config: {writeMode: 'allowed'},
        settings: {writeMode: 'allowed'},
      }),
    ).resolves.toBe(true);
    expect(seenArgs).toEqual([{param1: 'confirm'}]);
  });

  it.each([
    {
      name: 'with provided config',
      inputConfig: new BigQueryToolConfig({
        writeMode: WriteMode.BLOCKED,
        maxQueryResultRows: 50,
      }),
      expectedConfig: new BigQueryToolConfig({
        writeMode: WriteMode.BLOCKED,
        maxQueryResultRows: 50,
      }),
    },
    {
      name: 'with undefined config creates default',
      inputConfig: undefined,
      expectedConfig: new BigQueryToolConfig(),
    },
  ])('initializes toolConfig $name', ({inputConfig, expectedConfig}) => {
    const tool = new BigQueryTool({
      description: 'Config init test tool',
      parameters: sampleParameters,
      execute: sampleFunction,
      toolConfig: inputConfig,
    });

    expect(tool.toolConfig).toEqual(expectedConfig);
    expect(tool.toolSettings).toBe(tool.toolConfig);
  });
});
