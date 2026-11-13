/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthSchemeType,
  BaseAuthenticatedTool,
  BaseAuthenticatedToolParams,
  Context,
  CredentialManager,
  isBaseAuthenticatedTool,
  isBaseTool,
  RunAsyncAuthenticatedToolRequest,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

class TestAuthenticatedTool extends BaseAuthenticatedTool {
  runImplCalled = false;
  runImplResult: unknown = 'test_result';
  lastArgs?: Record<string, unknown>;
  lastToolContext?: Context;
  lastCredential?: AuthCredential;

  constructor(params: Partial<BaseAuthenticatedToolParams> = {}) {
    super({
      name: params.name ?? 'test_auth_tool',
      description: params.description ?? 'Test authenticated tool',
      isLongRunning: params.isLongRunning,
      authConfig: params.authConfig,
      responseForAuthRequired: params.responseForAuthRequired,
    });
  }

  get configuredCredentialsManager(): CredentialManager | undefined {
    return this.credentialsManager;
  }

  get configuredResponseForAuthRequired():
    Record<string, unknown> | string | undefined {
    return this.responseForAuthRequired;
  }

  protected override async runAsyncImpl({
    args,
    toolContext,
    credential,
  }: RunAsyncAuthenticatedToolRequest): Promise<unknown> {
    this.runImplCalled = true;
    this.lastArgs = args;
    this.lastToolContext = toolContext;
    this.lastCredential = credential;
    return this.runImplResult;
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

describe('BaseAuthenticatedTool', () => {
  describe('isBaseAuthenticatedTool', () => {
    it('identifies BaseAuthenticatedTool instances and preserves BaseTool brand', () => {
      const tool = new TestAuthenticatedTool();
      expect(isBaseAuthenticatedTool(tool)).toBe(true);
      expect(isBaseTool(tool)).toBe(true);
      expect(isBaseAuthenticatedTool({})).toBe(false);
      expect(isBaseAuthenticatedTool(null)).toBe(false);
      expect(isBaseAuthenticatedTool(undefined)).toBe(false);
    });
  });

  it('initializes with authConfig and custom responseForAuthRequired', () => {
    const authConfig = createTestAuthConfig();
    const responseForAuthRequired = {error: 'Not authenticated'};

    const tool = new TestAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig,
      responseForAuthRequired,
    });

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test description');
    expect(tool.configuredCredentialsManager).toBeDefined();
    expect(tool.configuredResponseForAuthRequired).toEqual(
      responseForAuthRequired,
    );
  });

  it('initializes without authConfig and skips credential manager creation', () => {
    const tool = new TestAuthenticatedTool();

    expect(tool.name).toBe('test_auth_tool');
    expect(tool.description).toBe('Test authenticated tool');
    expect(tool.configuredCredentialsManager).toBeUndefined();
    expect(tool.configuredResponseForAuthRequired).toBeUndefined();
  });

  it('skips credential manager creation when authConfig.authScheme is missing', () => {
    const authConfigWithoutScheme = {
      credentialKey: 'key-1',
    } as unknown as AuthConfig;

    const tool = new TestAuthenticatedTool({
      authConfig: authConfigWithoutScheme,
    });

    expect(tool.configuredCredentialsManager).toBeUndefined();
  });

  it('leaves responseForAuthRequired undefined when omitted', () => {
    const authConfig = createTestAuthConfig();

    const tool = new TestAuthenticatedTool({authConfig});

    expect(tool.configuredResponseForAuthRequired).toBeUndefined();
  });

  it('runs runAsyncImpl with undefined credential when no credential manager is configured', async () => {
    const tool = new TestAuthenticatedTool();
    const toolContext = {} as Context;
    const args = {param1: 'value1'};

    const result = await tool.runAsync({args, toolContext});

    expect(result).toBe('test_result');
    expect(tool.runImplCalled).toBe(true);
    expect(tool.lastArgs).toEqual(args);
    expect(tool.lastToolContext).toBe(toolContext);
    expect(tool.lastCredential).toBeUndefined();
  });

  it('resolves credential from CredentialManager and passes it to runAsyncImpl', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();
    const tool = new TestAuthenticatedTool({authConfig});

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      const result = await tool.runAsync({args, toolContext});

      expect(result).toBe('test_result');
      expect(tool.runImplCalled).toBe(true);
      expect(tool.lastArgs).toEqual(args);
      expect(tool.lastToolContext).toBe(toolContext);
      expect(tool.lastCredential).toBe(credential);
      expect(getAuthCredentialSpy).toHaveBeenCalledOnce();
      expect(getAuthCredentialSpy).toHaveBeenCalledWith(toolContext);
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('calls requestCredential and returns default pending message when no credential is available', async () => {
    const authConfig = createTestAuthConfig();
    const tool = new TestAuthenticatedTool({authConfig});

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(undefined);
    const requestCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'requestCredential')
      .mockResolvedValue();

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      const result = await tool.runAsync({args, toolContext});

      expect(result).toBe('Pending User Authorization.');
      expect(tool.runImplCalled).toBe(false);
      expect(getAuthCredentialSpy).toHaveBeenCalledOnce();
      expect(getAuthCredentialSpy).toHaveBeenCalledWith(toolContext);
      expect(requestCredentialSpy).toHaveBeenCalledOnce();
      expect(requestCredentialSpy).toHaveBeenCalledWith(toolContext);
    } finally {
      getAuthCredentialSpy.mockRestore();
      requestCredentialSpy.mockRestore();
    }
  });

  it('returns custom object responseForAuthRequired when no credential is available', async () => {
    const authConfig = createTestAuthConfig();
    const customResponse = {
      status: 'authentication_required',
      message: 'Please login',
    };
    const tool = new TestAuthenticatedTool({
      authConfig,
      responseForAuthRequired: customResponse,
    });

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(undefined);
    const requestCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'requestCredential')
      .mockResolvedValue();

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      const result = await tool.runAsync({args, toolContext});

      expect(result).toEqual(customResponse);
      expect(tool.runImplCalled).toBe(false);
      expect(getAuthCredentialSpy).toHaveBeenCalledOnce();
      expect(getAuthCredentialSpy).toHaveBeenCalledWith(toolContext);
      expect(requestCredentialSpy).toHaveBeenCalledOnce();
      expect(requestCredentialSpy).toHaveBeenCalledWith(toolContext);
    } finally {
      getAuthCredentialSpy.mockRestore();
      requestCredentialSpy.mockRestore();
    }
  });

  it('returns custom string responseForAuthRequired when no credential is available', async () => {
    const authConfig = createTestAuthConfig();
    const customResponse = 'Custom authentication required message';
    const tool = new TestAuthenticatedTool({
      authConfig,
      responseForAuthRequired: customResponse,
    });

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(undefined);
    const requestCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'requestCredential')
      .mockResolvedValue();

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      const result = await tool.runAsync({args, toolContext});

      expect(result).toBe(customResponse);
      expect(tool.runImplCalled).toBe(false);
    } finally {
      getAuthCredentialSpy.mockRestore();
      requestCredentialSpy.mockRestore();
    }
  });

  it('propagates errors thrown by runAsyncImpl', async () => {
    const authConfig = createTestAuthConfig();
    const credential = createTestAuthCredential();

    class FailingAuthenticatedTool extends TestAuthenticatedTool {
      protected override async runAsyncImpl(): Promise<unknown> {
        throw new Error('Implementation failed');
      }
    }

    const tool = new FailingAuthenticatedTool({authConfig});
    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockResolvedValue(credential);

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      await expect(tool.runAsync({args, toolContext})).rejects.toThrow(
        'Implementation failed',
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('forwards empty and complex argument objects to runAsyncImpl', async () => {
    const tool = new TestAuthenticatedTool();
    const toolContext = {} as Context;

    const emptyResult = await tool.runAsync({args: {}, toolContext});
    expect(emptyResult).toBe('test_result');
    expect(tool.lastArgs).toEqual({});

    const complexArgs = {
      stringParam: 'test',
      numberParam: 42,
      arrayParam: [1, 2, 3],
      nestedParam: {nested: 'value'},
    };
    const complexResult = await tool.runAsync({
      args: complexArgs,
      toolContext,
    });
    expect(complexResult).toBe('test_result');
    expect(tool.lastArgs).toEqual(complexArgs);
  });

  it('propagates errors thrown by CredentialManager.getAuthCredential', async () => {
    const authConfig = createTestAuthConfig();
    const tool = new TestAuthenticatedTool({authConfig});

    const getAuthCredentialSpy = vi
      .spyOn(CredentialManager.prototype, 'getAuthCredential')
      .mockRejectedValue(new Error('Credential service error'));

    try {
      const toolContext = {} as Context;
      const args = {param1: 'value1'};

      await expect(tool.runAsync({args, toolContext})).rejects.toThrow(
        'Credential service error',
      );
    } finally {
      getAuthCredentialSpy.mockRestore();
    }
  });

  it('returns undefined, object, and array values from runAsyncImpl', async () => {
    const tool = new TestAuthenticatedTool();
    const toolContext = {} as Context;
    const args = {};

    tool.runImplResult = undefined;
    expect(await tool.runAsync({args, toolContext})).toBeUndefined();

    tool.runImplResult = {key: 'value'};
    expect(await tool.runAsync({args, toolContext})).toEqual({key: 'value'});

    tool.runImplResult = [1, 2, 3];
    expect(await tool.runAsync({args, toolContext})).toEqual([1, 2, 3]);
  });
});
