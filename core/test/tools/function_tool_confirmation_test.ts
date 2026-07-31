/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  PluginManager,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v3';

function makeContext(options: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
}): Context {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u1',
  });
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: {name: 'a', runAsync: async function* () {}} as never,
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}

describe('FunctionTool require_confirmation', () => {
  function makeTool() {
    let ran = false;
    const tool = new FunctionTool({
      name: 'delete_file',
      description: 'Deletes a file.',
      parameters: z.object({path: z.string()}),
      execute: () => {
        ran = true;
        return 'deleted';
      },
      requireConfirmation: true,
    });
    return {tool, didRun: () => ran};
  }

  it('pauses and requests confirmation on first call', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(didRun()).toBe(false);
    expect(ctx.actions.requestedToolConfirmations['fc-1']).toBeDefined();
    expect(ctx.actions.skipSummarization).toBe(true);
  });

  it('runs the tool once the call is confirmed', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toBe('deleted');
    expect(didRun()).toBe(true);
  });

  it('rejects the tool call when confirmation is denied', async () => {
    const {tool, didRun} = makeTool();
    const ctx = makeContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: false}),
    });

    const result = await tool.runAsync({
      args: {path: '/tmp/x'},
      toolContext: ctx,
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(didRun()).toBe(false);
  });

  it('runs immediately when confirmation is not required', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'noop',
      description: 'no-op',
      execute: () => {
        ran = true;
        return 'ok';
      },
    });
    const ctx = makeContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({args: {}, toolContext: ctx});

    expect(result).toBe('ok');
    expect(ran).toBe(true);
  });

  it('supports a predicate to decide confirmation per-args', async () => {
    let ran = false;
    const tool = new FunctionTool({
      name: 'transfer',
      description: 'Transfers money.',
      parameters: z.object({amount: z.number()}),
      execute: () => {
        ran = true;
        return 'sent';
      },
      requireConfirmation: (input) => input.amount > 100,
    });

    // Small amount: no confirmation required, runs directly.
    const smallCtx = makeContext({functionCallId: 'fc-small'});
    expect(
      await tool.runAsync({args: {amount: 10}, toolContext: smallCtx}),
    ).toBe('sent');
    expect(ran).toBe(true);

    // Large amount: confirmation required, pauses.
    ran = false;
    const largeCtx = makeContext({functionCallId: 'fc-large'});
    const result = await tool.runAsync({
      args: {amount: 1000},
      toolContext: largeCtx,
    });
    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(ran).toBe(false);
  });
});
