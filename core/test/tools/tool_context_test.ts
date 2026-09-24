/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  AuthHandler,
  CallbackContext,
  Context,
  createEventActions,
  createSession,
  InvocationContext,
  PluginManager,
  State,
  ToolContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import type {AuthConfig, AuthCredential} from '../../src/tools/tool_context.js';
import * as toolContextModule from '../../src/tools/tool_context.js';

function newInvocationContext() {
  return new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'test-session',
      appName: 'tool-context-test',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function takesToolContext(context: ToolContext): string | undefined {
  return context.functionCallId;
}

describe('tool_context', () => {
  it('binds ToolContext to the Context class itself', () => {
    expect(ToolContext).toBe(Context);
  });

  it('binds CallbackContext to the same class as ToolContext', () => {
    expect(CallbackContext).toBe(Context);
    expect(ToolContext).toBe(CallbackContext);
  });

  it('builds a working context through the ToolContext name', () => {
    const eventActions = createEventActions();
    const context = new ToolContext({
      invocationContext: newInvocationContext(),
      eventActions,
      functionCallId: 'fc-1',
    });

    expect(context).toBeInstanceOf(Context);
    expect(context.actions).toBe(eventActions);
    expect(context.state).toBeInstanceOf(State);

    context.state.set('greeting', 'hello');

    expect(context.state.get('greeting')).toBe('hello');
    expect(eventActions.stateDelta).toEqual({greeting: 'hello'});
  });

  it('accepts a framework-built Context where a ToolContext is required', () => {
    const context = new Context({
      invocationContext: newInvocationContext(),
      functionCallId: 'fc-2',
    });

    expect(takesToolContext(context)).toBe('fc-2');
  });

  it('re-exports the auth names the Python module re-exports', () => {
    expect(toolContextModule.AuthHandler).toBe(AuthHandler);

    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'placeholder-key',
    };
    const config: AuthConfig = {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
      rawAuthCredential: credential,
      credentialKey: 'test-credential',
    };

    expect(config.rawAuthCredential).toBe(credential);
  });

  it('exports exactly the ported names', () => {
    expect(Object.keys(toolContextModule).sort()).toEqual([
      'AuthHandler',
      'CallbackContext',
      'ToolContext',
    ]);
  });
});
