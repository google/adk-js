/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CallbackContext,
  Context,
  createEventActions,
  createSession,
  FunctionTool,
  InvocationContext,
  PluginManager,
  State,
  ToolContext,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
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

  it('exports exactly the ported names', () => {
    expect(Object.keys(toolContextModule).sort()).toEqual([
      'CallbackContext',
      'ToolContext',
    ]);
  });

  it('runs a tool whose execute declares a ToolContext parameter', async () => {
    const rememberTool = new FunctionTool({
      name: 'remember',
      description: 'Stores a value in session state.',
      parameters: z.object({key: z.string(), value: z.string()}),
      execute: async (input, toolContext?: ToolContext) => {
        toolContext?.state.set(input.key, input.value);
        return `stored ${input.key}`;
      },
    });

    const eventActions = createEventActions();
    const context = new ToolContext({
      invocationContext: newInvocationContext(),
      eventActions,
      functionCallId: 'fc-3',
    });

    const result = await rememberTool.runAsync({
      args: {key: 'city', value: 'Paris'},
      toolContext: context,
    });

    expect(result).toBe('stored city');
    expect(context.state.get('city')).toBe('Paris');
    expect(eventActions.stateDelta).toEqual({city: 'Paris'});
  });
});
