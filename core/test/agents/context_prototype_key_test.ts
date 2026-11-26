/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthScheme,
  Context,
  InvocationContext,
  PluginManager,
  SessionArtifactService,
  createEvent,
  createSession,
  functionsExportedForTestingOnly,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const {generateAuthEvent, generateRequestConfirmationEvent} =
  functionsExportedForTestingOnly;

const TEST_AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Test-Api-Key',
};

function createTestAuthConfig(): AuthConfig {
  return {
    credentialKey: 'test-credential-key',
    authScheme: TEST_AUTH_SCHEME,
  };
}

function createMockArtifactService(version: number): SessionArtifactService {
  return {
    saveArtifact: vi.fn().mockResolvedValue(version),
    loadArtifact: vi.fn().mockResolvedValue(undefined),
    listArtifactKeys: vi.fn().mockResolvedValue([]),
    deleteArtifact: vi.fn().mockResolvedValue(undefined),
    listVersions: vi.fn().mockResolvedValue([]),
    listArtifactVersions: vi.fn().mockResolvedValue([]),
    getArtifactVersion: vi.fn().mockResolvedValue(undefined),
  };
}

function createInvocationContext(
  artifactService?: SessionArtifactService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    session: createSession({
      id: 'test-session-id',
      appName: 'test-app',
      userId: 'test-user',
      state: {},
    }),
    pluginManager: new PluginManager([]),
    artifactService,
  });
}

function confirmationContext() {
  const invocationContext = createInvocationContext();
  const context = new Context({
    invocationContext,
    functionCallId: '__proto__',
  });
  context.requestConfirmation({hint: 'dangerous tool'});
  return {invocationContext, context};
}

function credentialContext() {
  const invocationContext = createInvocationContext();
  const context = new Context({
    invocationContext,
    functionCallId: '__proto__',
  });
  context.requestCredential(createTestAuthConfig());
  return {invocationContext, context};
}

describe('context keys named __proto__', () => {
  it('stores a __proto__ function call id as an own confirmation entry', () => {
    const {context} = confirmationContext();
    const confirmations = context.actions.requestedToolConfirmations;

    expect(Object.getPrototypeOf(confirmations)).toBe(Object.prototype);
    expect(Object.hasOwn(confirmations, '__proto__')).toBe(true);
  });

  it('emits a confirmation call for a __proto__ function call id', () => {
    const {invocationContext, context} = confirmationContext();
    const functionCallEvent = createEvent({
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: 'dangerous_tool', args: {}, id: '__proto__'}},
        ],
      },
    });
    const functionResponseEvent = createEvent({
      actions: context.actions,
      content: {role: 'user', parts: []},
    });

    const event = generateRequestConfirmationEvent({
      invocationContext,
      functionCallEvent,
      functionResponseEvent,
    });

    expect(event?.content?.parts?.length).toBe(1);
    expect(event!.content!.parts![0].functionCall?.name).toBe(
      'adk_request_confirmation',
    );
  });

  it('stores a __proto__ function call id as an own auth config entry', () => {
    const {context} = credentialContext();
    const authConfigs = context.actions.requestedAuthConfigs;

    expect(Object.getPrototypeOf(authConfigs)).toBe(Object.prototype);
    expect(Object.hasOwn(authConfigs, '__proto__')).toBe(true);
  });

  it('emits a credential call for a __proto__ function call id', () => {
    const {invocationContext, context} = credentialContext();
    const functionResponseEvent = createEvent({
      actions: context.actions,
      content: {role: 'user', parts: []},
    });

    const event = generateAuthEvent(invocationContext, functionResponseEvent);

    expect(event?.content?.parts?.length).toBe(1);
    expect(event!.content!.parts![0].functionCall?.name).toBe(
      'adk_request_credential',
    );
  });

  it('stores a __proto__ artifact filename as an own artifactDelta entry', async () => {
    const artifactService = createMockArtifactService(7);
    const context = new Context({
      invocationContext: createInvocationContext(artifactService),
    });

    const version = await context.saveArtifact('__proto__', {text: 'content'});

    expect(version).toBe(7);
    expect(Object.getPrototypeOf(context.actions.artifactDelta)).toBe(
      Object.prototype,
    );
    expect(Object.hasOwn(context.actions.artifactDelta, '__proto__')).toBe(
      true,
    );
    expect(context.actions.artifactDelta['__proto__']).toBe(7);
  });
});
