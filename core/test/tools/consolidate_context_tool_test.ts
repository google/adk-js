/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  ConsolidateContextTool,
  Context,
  createSession,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('ConsolidateContextTool', () => {
  it('computes the correct declaration', () => {
    const tool = new ConsolidateContextTool();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toEqual('consolidate_context');
    expect(declaration?.description).toContain(
      'Requests context consolidation',
    );
    expect(declaration?.parameters?.type).toEqual(Type.OBJECT);
    expect(declaration?.parameters?.properties?.['detail']?.type).toEqual(
      Type.STRING,
    );
  });

  it('sets consolidate flags on runAsync', async () => {
    const tool = new ConsolidateContextTool();
    const session = createSession({id: 'test-session', appName: 'test-app'});
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: {} as BaseAgent,
      session,
      pluginManager: new PluginManager([]),
    });
    const toolContext = new Context({invocationContext});

    const result = (await tool.runAsync({
      args: {detail: 'Finished step 1'},
      toolContext,
    })) as {status: string; message: string};

    expect(result.status).toEqual('success');
    expect(toolContext.state.get('temp:consolidate_context')).toBe(true);
    expect(toolContext.state.get('temp:consolidate_context_detail')).toEqual(
      'Finished step 1',
    );
  });

  it('sets consolidate flags without detail on runAsync', async () => {
    const tool = new ConsolidateContextTool();
    const session = createSession({id: 'test-session', appName: 'test-app'});
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      agent: {} as BaseAgent,
      session,
      pluginManager: new PluginManager([]),
    });
    const toolContext = new Context({invocationContext});

    const result = (await tool.runAsync({
      args: {},
      toolContext,
    })) as {status: string; message: string};

    expect(result.status).toEqual('success');
    expect(toolContext.state.get('temp:consolidate_context')).toBe(true);
    expect(
      toolContext.state.get('temp:consolidate_context_detail'),
    ).toBeUndefined();
  });
});
