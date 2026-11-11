/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, FunctionTool, State} from '@google/adk';
import {
  type BigQueryCredentials,
  BigQueryCredentialsConfig,
  BigQueryTool,
  type GoogleOAuthCredentials,
  isBigQueryTool,
} from '@google/adk-integrations';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {GoogleCredentialsManager} from '../../src/bigquery/bigquery_credentials.js';

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

  it('identifies BigQueryTool instances via isBigQueryTool', () => {
    const tool = createSampleTool(credentialsConfig);
    const fnTool = new FunctionTool({
      name: 'plain_fn',
      description: 'Plain function tool',
      execute: () => 'ok',
    });

    expect(isBigQueryTool(tool)).toBe(true);
    expect(isBigQueryTool(fnTool)).toBe(false);
    expect(isBigQueryTool({})).toBe(false);
    expect(isBigQueryTool(null)).toBe(false);
  });

  // reference: test_tool_initialization_with_credentials
  it('creates a credentials manager when credentialsConfig is given', () => {
    const tool = createSampleTool(credentialsConfig);

    expect(tool.name).toBe('sampleFunction');
    expect(tool.credentialsManager).toBeInstanceOf(GoogleCredentialsManager);
    expect(tool.ignoreParams).toContain('credentials');
  });

  // reference: test_tool_initialization_without_credentials
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

  // reference: test_run_async_with_valid_credentials
  it('passes resolved credentials to execute', async () => {
    const tool = createSampleTool(credentialsConfig);
    const mockToolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
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

  // reference: test_run_async_oauth_flow_in_progress
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
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
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

  // reference: test_run_async_without_credentials_manager
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

  // reference: test_run_async_with_async_function
  it('awaits an async execute function', async () => {
    const tool = new BigQueryTool({
      description: 'Async sample tool',
      parameters: sampleParameters,
      execute: asyncSampleFunction,
      credentialsConfig,
    });
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};
    vi.spyOn(
      tool.credentialsManager as GoogleCredentialsManager,
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

  // reference: test_run_async_exception_handling
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
      tool.credentialsManager as GoogleCredentialsManager,
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
      tool.credentialsManager as GoogleCredentialsManager,
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
      tool.credentialsManager as GoogleCredentialsManager,
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

  // reference: test_function_signature_analysis
  it('omits credentials from the function declaration', () => {
    const tool = new BigQueryTool({
      name: 'complex_function',
      description: 'A tool with required, optional, and credentials parameters',
      parameters: z.object({
        requiredParam: z.string(),
        optionalParam: z.string().optional(),
        credentials: z.unknown().optional(),
      }),
      execute: () => ({success: true}),
      credentialsConfig,
    });

    const declaration = tool._getDeclaration();
    const requiredArgs = declaration.parameters?.required ?? [];
    const properties = declaration.parameters?.properties ?? {};

    expect(requiredArgs).toContain('requiredParam');
    expect(requiredArgs).not.toContain('credentials');
    expect(requiredArgs).not.toContain('optionalParam');
    expect(properties['credentials']).toBeUndefined();
    expect(properties['requiredParam']).toBeDefined();
    expect(properties['optionalParam']).toBeDefined();
  });
});
