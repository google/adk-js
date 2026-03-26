/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {z as z4} from 'zod/v4';
import {Context} from '../../src/agents/context.js';
import {AuthenticatedFunctionTool} from '../../src/tools/authenticated_function_tool.js';

describe('AuthenticatedFunctionTool', () => {
  it('runs normally when auth is not configured', async () => {
    const tool = new AuthenticatedFunctionTool({
      name: 'testTool',
      description: 'A test tool.',
      parameters: z4.object({a: z4.number()}),
      execute: async ({a}) => {
        return a;
      },
    });

    const emptyContext = {} as unknown as Context;
    const result = await tool.runAsync({
      args: {a: 42},
      toolContext: emptyContext,
    });
    expect(result).toEqual(42);
  });

  it('requests auth and returns pending message when credential is missing', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };

    const tool = new AuthenticatedFunctionTool({
      name: 'testTool',
      description: 'A test tool.',
      authConfig: mockAuthConfig as any,
      execute: async () => {
        return 'success';
      },
    });

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await tool.runAsync({
      args: {},
      toolContext: mockContext,
    });

    expect(result).toEqual('Pending User Authorization.');
    expect(mockContext.requestCredential).toHaveBeenCalledWith(mockAuthConfig);
  });

  it('injects credential into arguments when available', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };
    const mockCredential = {accessToken: 'secret'};

    const tool = new AuthenticatedFunctionTool({
      name: 'testTool',
      description: 'A test tool.',
      authConfig: mockAuthConfig as any,
      parameters: z4.object({}),
      execute: async (args: any) => {
        return args.credential;
      },
    });

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(mockCredential),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await tool.runAsync({
      args: {},
      toolContext: mockContext,
    });

    expect(result).toEqual(mockCredential);
  });

  it('returns custom response for auth required', async () => {
    const mockAuthConfig = {
      authScheme: {type: 'oauth2'},
      credentialKey: 'test-key',
    };

    const tool = new AuthenticatedFunctionTool({
      name: 'testTool',
      description: 'A test tool.',
      authConfig: mockAuthConfig as any,
      responseForAuthRequired: 'Please authorize first.',
      execute: async () => {
        return 'success';
      },
    });

    const mockContext = {
      invocationContext: {},
      getAuthResponse: vi.fn().mockReturnValue(undefined),
      requestCredential: vi.fn(),
    } as unknown as Context;

    const result = await tool.runAsync({
      args: {},
      toolContext: mockContext,
    });

    expect(result).toEqual('Please authorize first.');
  });
});
