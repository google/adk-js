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
  Context,
  InMemoryCredentialService,
  InvocationContext,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function createMockContext(appName: string, userId: string): Context {
  return new Context({
    invocationContext: {
      session: createSession({id: 'test-id', appName, userId}),
    } as unknown as InvocationContext,
  });
}

describe('InMemoryCredentialService', () => {
  it('should return undefined if no credential saved', async () => {
    const service = new InMemoryCredentialService();
    const context = createMockContext('testApp', 'user1');
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
    };

    const result = await service.loadCredential(authConfig, context);
    expect(result).toBeUndefined();
  });

  it('should save and load credential', async () => {
    const service = new InMemoryCredentialService();
    const context = createMockContext('testApp', 'user1');
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: credential,
    };

    await service.saveCredential(authConfig, context);

    const loaded = await service.loadCredential(authConfig, context);
    expect(loaded).toEqual(credential);
  });

  it('should isolate by appName and userId', async () => {
    const service = new InMemoryCredentialService();
    const context1 = createMockContext('app1', 'user1');
    const context2 = createMockContext('app2', 'user1');
    const context3 = createMockContext('app1', 'user2');

    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret',
    };
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: credential,
    };

    await service.saveCredential(authConfig, context1);

    expect(await service.loadCredential(authConfig, context1)).toEqual(
      credential,
    );
    expect(await service.loadCredential(authConfig, context2)).toBeUndefined();
    expect(await service.loadCredential(authConfig, context3)).toBeUndefined();
  });

  it('should skip save if exchangedAuthCredential is not provided', async () => {
    const service = new InMemoryCredentialService();
    const context = createMockContext('testApp', 'user1');
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
    };

    await service.saveCredential(authConfig, context);

    const loaded = await service.loadCredential(authConfig, context);
    expect(loaded).toBeUndefined();
  });
});
