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
import {afterEach, describe, expect, it} from 'vitest';

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

  it('should update an existing credential when saved again under the same key', async () => {
    const service = new InMemoryCredentialService();
    const context = createMockContext('testApp', 'user1');
    const initialCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'initial-client-id',
        clientSecret: 'initial-client-secret',
      },
    };
    const updatedCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'updated-client-id',
        clientSecret: 'updated-client-secret',
      },
    };
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: initialCredential,
    };

    await service.saveCredential(authConfig, context);
    await service.saveCredential(
      {...authConfig, exchangedAuthCredential: updatedCredential},
      context,
    );

    const loaded = await service.loadCredential(authConfig, context);
    expect(loaded).toEqual(updatedCredential);
  });

  it('should store multiple credentials under different keys in the same context', async () => {
    const service = new InMemoryCredentialService();
    const context = createMockContext('testApp', 'user1');
    const credential1: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-1',
    };
    const credential2: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-2',
    };
    const authConfig1: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: credential1,
    };
    const authConfig2: AuthConfig = {
      credentialKey: 'key2',
      authScheme: {} as AuthScheme,
      exchangedAuthCredential: credential2,
    };

    await service.saveCredential(authConfig1, context);
    await service.saveCredential(authConfig2, context);

    expect(await service.loadCredential(authConfig1, context)).toEqual(
      credential1,
    );
    expect(await service.loadCredential(authConfig2, context)).toEqual(
      credential2,
    );
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

  describe('prototype pollution', () => {
    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>)['user1'];
    });

    it('does not pollute Object.prototype via appName', async () => {
      const service = new InMemoryCredentialService();
      const context = createMockContext('__proto__', 'user1');
      const authConfig: AuthConfig = {
        credentialKey: 'key1',
        authScheme: {} as AuthScheme,
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'secret',
        },
      };

      await service.saveCredential(authConfig, context);

      expect(({} as Record<string, unknown>)['user1']).toBeUndefined();
    });

    it('returns undefined for inherited credentialKey names', async () => {
      const service = new InMemoryCredentialService();
      const context = createMockContext('testApp', 'user1');

      for (const credentialKey of ['toString', 'constructor', '__proto__']) {
        const loaded = await service.loadCredential(
          {credentialKey, authScheme: {} as AuthScheme},
          context,
        );
        expect(loaded).toBeUndefined();
      }
    });
  });
});
