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
  BaseCredentialService,
  CallbackContext,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  PluginManager,
  SessionArtifactService,
  State,
  ToolContext,
  createEventActions,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const TEST_AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Test-Api-Key',
};

function createTestAuthConfig(
  exchangedAuthCredential?: AuthCredential,
): AuthConfig {
  return {
    credentialKey: 'test-credential-key',
    authScheme: TEST_AUTH_SCHEME,
    exchangedAuthCredential,
  };
}

function createMockArtifactService(
  overrides: Partial<SessionArtifactService> = {},
): SessionArtifactService {
  return {
    saveArtifact: vi.fn().mockResolvedValue(1),
    loadArtifact: vi.fn().mockResolvedValue(undefined),
    listArtifactKeys: vi
      .fn()
      .mockResolvedValue(['file1.txt', 'file2.txt', 'file3.txt']),
    deleteArtifact: vi.fn().mockResolvedValue(undefined),
    listVersions: vi.fn().mockResolvedValue([]),
    listArtifactVersions: vi.fn().mockResolvedValue([]),
    getArtifactVersion: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockCredentialService(
  overrides: Partial<BaseCredentialService> = {},
): BaseCredentialService {
  return {
    loadCredential: vi.fn().mockResolvedValue(undefined),
    saveCredential: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createTestInvocationContext(
  options: {
    artifactService?: SessionArtifactService;
    credentialService?: BaseCredentialService;
  } = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    session: createSession({
      id: 'test-session-id',
      appName: 'test-app',
      userId: 'test-user',
      state: {key1: 'value1', key2: 'value2'},
    }),
    pluginManager: new PluginManager([]),
    artifactService: options.artifactService,
    credentialService: options.credentialService,
  });
}

describe('Context', () => {
  it('initializes invocationContext, eventActions, and state backed by session state', () => {
    const invocationContext = createTestInvocationContext();
    const context = new Context({invocationContext});

    expect(context.invocationContext).toBe(invocationContext);
    expect(context.eventActions).toEqual(createEventActions());
    expect(context.state).toBeInstanceOf(State);
    expect(context.state.get('key1')).toBe('value1');
  });

  describe('listArtifacts', () => {
    it('returns artifact keys from the artifact service', async () => {
      const artifactService = createMockArtifactService();
      const context = new Context({
        invocationContext: createTestInvocationContext({artifactService}),
      });

      const result = await context.listArtifacts();

      expect(result).toEqual(['file1.txt', 'file2.txt', 'file3.txt']);
      expect(artifactService.listArtifactKeys).toHaveBeenCalledTimes(1);
    });

    it('returns an empty array when no artifacts exist', async () => {
      const artifactService = createMockArtifactService({
        listArtifactKeys: vi.fn().mockResolvedValue([]),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({artifactService}),
      });

      const result = await context.listArtifacts();

      expect(result).toEqual([]);
      expect(artifactService.listArtifactKeys).toHaveBeenCalledTimes(1);
    });

    it('throws when artifactService is not initialized', () => {
      const context = new Context({
        invocationContext: createTestInvocationContext(),
      });

      expect(() => context.listArtifacts()).toThrow(
        'Artifact service is not initialized.',
      );
    });

    it('propagates errors thrown by artifactService.listArtifactKeys', async () => {
      const artifactService = createMockArtifactService({
        listArtifactKeys: vi.fn().mockRejectedValue(new Error('Service error')),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({artifactService}),
      });

      await expect(context.listArtifacts()).rejects.toThrow('Service error');
    });

    it('exposes identical listArtifacts behavior on ToolContext and CallbackContext', async () => {
      const artifactService = createMockArtifactService();
      const toolContext = new ToolContext({
        invocationContext: createTestInvocationContext({artifactService}),
      });
      const unconfiguredToolContext = new ToolContext({
        invocationContext: createTestInvocationContext(),
      });

      expect(typeof ToolContext.prototype.listArtifacts).toBe('function');
      expect(typeof CallbackContext.prototype.listArtifacts).toBe('function');
      expect(ToolContext.prototype.listArtifacts).toBe(
        CallbackContext.prototype.listArtifacts,
      );

      await expect(toolContext.listArtifacts()).resolves.toEqual([
        'file1.txt',
        'file2.txt',
        'file3.txt',
      ]);
      expect(artifactService.listArtifactKeys).toHaveBeenCalledTimes(1);
      expect(() => unconfiguredToolContext.listArtifacts()).toThrow(
        'Artifact service is not initialized.',
      );
    });
  });

  describe('saveArtifact and loadArtifact', () => {
    it('delegates saveArtifact to artifactService and updates artifactDelta', async () => {
      const artifactService = createMockArtifactService({
        saveArtifact: vi.fn().mockResolvedValue(1),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({artifactService}),
      });
      const testArtifact: Part = {text: 'test content'};

      const version = await context.saveArtifact('test_file.txt', testArtifact);

      expect(version).toBe(1);
      expect(artifactService.saveArtifact).toHaveBeenCalledWith({
        filename: 'test_file.txt',
        artifact: testArtifact,
      });
      expect(context.eventActions.artifactDelta).toEqual({
        'test_file.txt': 1,
      });
    });

    it('delegates loadArtifact to artifactService', async () => {
      const testArtifact: Part = {text: 'test content'};
      const artifactService = createMockArtifactService({
        loadArtifact: vi.fn().mockResolvedValue(testArtifact),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({artifactService}),
      });

      const result = await context.loadArtifact('test_file.txt');

      expect(result).toEqual(testArtifact);
      expect(artifactService.loadArtifact).toHaveBeenCalledWith({
        filename: 'test_file.txt',
        version: undefined,
      });
    });
  });

  describe('saveCredential', () => {
    it('delegates saveCredential with authConfig and context to credentialService', async () => {
      const credentialService = createMockCredentialService();
      const context = new Context({
        invocationContext: createTestInvocationContext({credentialService}),
      });
      const authConfig = createTestAuthConfig();

      await context.saveCredential(authConfig);

      expect(credentialService.saveCredential).toHaveBeenCalledWith(
        authConfig,
        context,
      );
    });

    it('rejects when credentialService is not initialized', async () => {
      const context = new Context({
        invocationContext: createTestInvocationContext(),
      });

      await expect(
        context.saveCredential(createTestAuthConfig()),
      ).rejects.toThrow('Credential service is not initialized.');
    });
  });

  describe('loadCredential', () => {
    it('delegates loadCredential to credentialService and returns the credential', async () => {
      const expectedCredential: AuthCredential = {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'placeholder-token-1'},
      };
      const credentialService = createMockCredentialService({
        loadCredential: vi.fn().mockResolvedValue(expectedCredential),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({credentialService}),
      });
      const authConfig = createTestAuthConfig();

      const result = await context.loadCredential(authConfig);

      expect(credentialService.loadCredential).toHaveBeenCalledWith(
        authConfig,
        context,
      );
      expect(result).toEqual(expectedCredential);
    });

    it('returns undefined when no credential is stored', async () => {
      const credentialService = createMockCredentialService({
        loadCredential: vi.fn().mockResolvedValue(undefined),
      });
      const context = new Context({
        invocationContext: createTestInvocationContext({credentialService}),
      });
      const authConfig = createTestAuthConfig();

      const result = await context.loadCredential(authConfig);

      expect(credentialService.loadCredential).toHaveBeenCalledWith(
        authConfig,
        context,
      );
      expect(result).toBeUndefined();
    });

    it('rejects when credentialService is not initialized', async () => {
      const context = new Context({
        invocationContext: createTestInvocationContext(),
      });

      await expect(
        context.loadCredential(createTestAuthConfig()),
      ).rejects.toThrow('Credential service is not initialized.');
    });

    it('persists and loads credentials round-trip with InMemoryCredentialService', async () => {
      const credentialService = new InMemoryCredentialService();
      const context = new CallbackContext({
        invocationContext: createTestInvocationContext({credentialService}),
      });
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'placeholder-credential-value',
      };
      const authConfig = createTestAuthConfig(credential);

      expect(await context.loadCredential(authConfig)).toBeUndefined();

      await context.saveCredential(authConfig);

      expect(await context.loadCredential(authConfig)).toEqual(credential);
    });
  });
});
