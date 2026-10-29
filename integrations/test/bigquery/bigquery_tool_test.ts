/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Context, FunctionTool} from '@google/adk';
import {
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
    state: {},
  } as unknown as Context;
}

function sampleFunction(args: {
  param1: string;
  credentials?: GoogleOAuthCredentials;
}): {result: string; authenticated: boolean} {
  if (args.credentials) {
    return {result: `Success with ${args.param1}`, authenticated: true};
  }
  return {result: `Success with ${args.param1}`, authenticated: false};
}

async function asyncSampleFunction(args: {
  param1: string;
  credentials?: GoogleOAuthCredentials;
}): Promise<{result: string; authenticated: boolean}> {
  if (args.credentials) {
    return {result: `Async success with ${args.param1}`, authenticated: true};
  }
  return {result: `Async success with ${args.param1}`, authenticated: false};
}

describe('BigQueryTool', () => {
  const credentialsConfig = new BigQueryCredentialsConfig({
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    scopes: ['https://www.googleapis.com/auth/bigquery'],
  });

  it('identifies BigQueryTool instances via isBigQueryTool', () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: credentialsConfig,
    });
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

  it('test_tool_initialization_with_credentials', () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: credentialsConfig,
    });

    expect(tool.func).toBe(sampleFunction);
    expect(tool.credentialsManager).not.toBeNull();
    expect(tool.credentialsManager).toBeInstanceOf(GoogleCredentialsManager);
    expect(tool.ignoreParams).toContain('credentials');
  });

  it('test_tool_initialization_without_credentials', () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: null,
    });

    expect(tool.func).toBe(sampleFunction);
    expect(tool.credentialsManager).toBeNull();
  });

  it('test_run_async_with_valid_credentials', async () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: credentialsConfig,
    });
    const mockToolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(mockCreds);

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as {result: string; authenticated: boolean};

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(mockToolContext);
    expect(result.result).toBe('Success with test_value');
    expect(result.authenticated).toBe(true);
    getCredsSpy.mockRestore();
  });

  it('test_run_async_oauth_flow_in_progress', async () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: credentialsConfig,
    });
    const mockToolContext = createMockToolContext();

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(null);

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as string;

    expect(getCredsSpy).toHaveBeenCalledOnce();
    expect(getCredsSpy).toHaveBeenCalledWith(mockToolContext);
    expect(result.toLowerCase()).toContain('authorization is required');
    expect(result).toContain(tool.name);
    getCredsSpy.mockRestore();
  });

  it('test_run_async_without_credentials_manager', async () => {
    const tool = new BigQueryTool({
      func: sampleFunction,
      credentials: null,
    });
    const mockToolContext = createMockToolContext();

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as {result: string; authenticated: boolean};

    expect(result.result).toBe('Success with test_value');
    expect(result.authenticated).toBe(false);
  });

  it('test_run_async_with_async_function', async () => {
    const tool = new BigQueryTool({
      func: asyncSampleFunction,
      credentials: credentialsConfig,
    });
    const mockToolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(mockCreds);

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as {result: string; authenticated: boolean};

    expect(result.result).toBe('Async success with test_value');
    expect(result.authenticated).toBe(true);
    getCredsSpy.mockRestore();
  });

  it('test_run_async_exception_handling', async () => {
    function failingFunction(): never {
      throw new Error('Something went wrong');
    }

    const tool = new BigQueryTool({
      func: failingFunction,
      credentials: credentialsConfig,
    });
    const mockToolContext = createMockToolContext();
    const mockCreds: GoogleOAuthCredentials = {valid: true, token: 'tok'};

    const getCredsSpy = vi
      .spyOn(
        tool.credentialsManager as GoogleCredentialsManager,
        'getValidCredentials',
      )
      .mockResolvedValue(mockCreds);

    const result = (await tool.runAsync({
      args: {param1: 'test_value'},
      toolContext: mockToolContext,
    })) as {status: string; error_details: string};

    expect(result.status).toBe('ERROR');
    expect(result.error_details).toContain('Something went wrong');
    getCredsSpy.mockRestore();
  });

  it('test_function_signature_analysis', () => {
    const tool = new BigQueryTool({
      name: 'complex_function',
      description: 'A tool with required, optional, and credentials parameters',
      parameters: z.object({
        required_param: z.string(),
        optional_param: z.string().optional(),
        credentials: z.unknown().optional(),
      }),
      func: () => ({success: true}),
      credentials: credentialsConfig,
    });

    const declaration = tool._getDeclaration();
    const requiredArgs = declaration.parameters?.required ?? [];
    const properties = declaration.parameters?.properties ?? {};

    expect(requiredArgs).toContain('required_param');
    expect(requiredArgs).not.toContain('credentials');
    expect(requiredArgs).not.toContain('optional_param');
    expect(properties['credentials']).toBeUndefined();
    expect(properties['required_param']).toBeDefined();
    expect(properties['optional_param']).toBeDefined();
  });
});
