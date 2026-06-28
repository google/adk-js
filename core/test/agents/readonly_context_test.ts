/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    appName: 'test-app',
    userId: 'user-1',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
    ...overrides,
  } as Session;
}

function makeInvocationContext(
  overrides: Partial<{
    invocationId: string;
    userContent: Content;
    session: Session;
    agentName: string;
  }> = {},
): InvocationContext {
  const agent = new LlmAgent({name: overrides.agentName ?? 'test-agent'});
  const session = overrides.session ?? makeSession();

  return new InvocationContext({
    invocationId: overrides.invocationId ?? 'inv-123',
    agent,
    session,
    userContent: overrides.userContent,
    pluginManager: new PluginManager(),
  });
}

describe('ReadonlyContext', () => {
  it('should construct without errors given a minimal InvocationContext', () => {
    const ic = makeInvocationContext();
    const ctx = new ReadonlyContext(ic);
    expect(ctx).toBeInstanceOf(ReadonlyContext);
  });

  it('invocationId delegates to the underlying InvocationContext', () => {
    const ic = makeInvocationContext({invocationId: 'my-inv-id'});
    const ctx = new ReadonlyContext(ic);
    expect(ctx.invocationId).toBe('my-inv-id');
  });

  it('userId delegates to the underlying session userId', () => {
    const session = makeSession({userId: 'alice'});
    const ic = makeInvocationContext({session});
    const ctx = new ReadonlyContext(ic);
    expect(ctx.userId).toBe('alice');
  });

  it('sessionId delegates to the underlying session id', () => {
    const session = makeSession({id: 'sess-42'});
    const ic = makeInvocationContext({session});
    const ctx = new ReadonlyContext(ic);
    expect(ctx.sessionId).toBe('sess-42');
  });

  it('agentName delegates to the underlying agent name', () => {
    const ic = makeInvocationContext({agentName: 'my-agent'});
    const ctx = new ReadonlyContext(ic);
    expect(ctx.agentName).toBe('my-agent');
  });

  it('userContent delegates to the underlying InvocationContext userContent', () => {
    const content: Content = {
      role: 'user',
      parts: [{text: 'hello'}],
    };
    const ic = makeInvocationContext({userContent: content});
    const ctx = new ReadonlyContext(ic);
    expect(ctx.userContent).toEqual(content);
  });

  it('userContent is undefined when not set on InvocationContext', () => {
    const ic = makeInvocationContext();
    const ctx = new ReadonlyContext(ic);
    expect(ctx.userContent).toBeUndefined();
  });

  it('state returns a State wrapping the session state values', () => {
    const session = makeSession({state: {foo: 'bar', count: 42}});
    const ic = makeInvocationContext({session});
    const ctx = new ReadonlyContext(ic);
    const state = ctx.state;
    expect(state.get('foo')).toBe('bar');
    expect(state.get('count')).toBe(42);
  });

  it('state returns a new State instance on each access', () => {
    const session = makeSession({state: {x: 1}});
    const ic = makeInvocationContext({session});
    const ctx = new ReadonlyContext(ic);
    const state1 = ctx.state;
    const state2 = ctx.state;
    // Each call returns a new wrapper around the same underlying data
    expect(state1).not.toBe(state2);
    expect(state1.get('x')).toBe(state2.get('x'));
  });
});
