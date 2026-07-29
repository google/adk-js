/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createEventActions,
  EventActions,
  EXIT_LOOP,
  FunctionTool,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';
import {ReplayPlugin} from '../../src/integration/replay_plugin.js';
import {Recording} from '../../src/integration/test_types.js';

const AGENT_NAME = 'refiner_agent';

const TRANSFER_TO_AGENT = new FunctionTool({
  name: 'transfer_to_agent',
  description: 'Transfers to another agent.',
  execute: async () => ({}),
});

const GREET = new FunctionTool({
  name: 'greet',
  description: 'Greets the user.',
  execute: async () => ({}),
});

function toolRecording(
  name: string,
  response: Record<string, unknown>,
): Recording {
  return {
    userMessageIndex: 0,
    agentName: AGENT_NAME,
    toolRecording: {toolCall: {name}, toolResponse: {response}},
  };
}

describe('ReplayPlugin', () => {
  let actions: EventActions;
  let toolContext: Context;

  beforeEach(() => {
    actions = createEventActions();
    toolContext = {
      actions,
      invocationContext: {agent: {name: AGENT_NAME}},
    } as unknown as Context;
  });

  it('replays the recorded response and escalates for exit_loop', async () => {
    const plugin = new ReplayPlugin(
      [toolRecording('exit_loop', {result: null})],
      {
        userMessageIndex: 0,
      },
    );

    const response = await plugin.beforeToolCallback({
      tool: EXIT_LOOP,
      toolArgs: {},
      toolContext,
    });

    expect(response).toEqual({result: null});
    expect(actions.escalate).toBe(true);
    expect(actions.skipSummarization).toBe(true);
  });

  it('replays transfer_to_agent by setting transferToAgent', async () => {
    const plugin = new ReplayPlugin(
      [toolRecording('transfer_to_agent', {result: null})],
      {userMessageIndex: 0},
    );

    await plugin.beforeToolCallback({
      tool: TRANSFER_TO_AGENT,
      toolArgs: {agentName: 'writer_agent'},
      toolContext,
    });

    expect(actions.transferToAgent).toBe('writer_agent');
    expect(actions.escalate).toBeUndefined();
  });

  it('replays a plain tool without touching the actions', async () => {
    const plugin = new ReplayPlugin(
      [toolRecording('greet', {greeting: 'hi'})],
      {
        userMessageIndex: 0,
      },
    );

    const response = await plugin.beforeToolCallback({
      tool: GREET,
      toolArgs: {},
      toolContext,
    });

    expect(response).toEqual({greeting: 'hi'});
    expect(actions).toEqual(createEventActions());
  });

  it('throws when no recording matches the tool call', async () => {
    const plugin = new ReplayPlugin([], {userMessageIndex: 0});

    await expect(
      plugin.beforeToolCallback({tool: GREET, toolArgs: {}, toolContext}),
    ).rejects.toThrow(
      `No tool recording found for agent ${AGENT_NAME}, tool greet at turn 0`,
    );
  });

  it('consumes each recording only once', async () => {
    const plugin = new ReplayPlugin(
      [toolRecording('greet', {greeting: 'hi'})],
      {
        userMessageIndex: 0,
      },
    );
    const call = () =>
      plugin.beforeToolCallback({tool: GREET, toolArgs: {}, toolContext});

    await call();

    await expect(call()).rejects.toThrow(
      `No tool recording found for agent ${AGENT_NAME}, tool greet at turn 0`,
    );
  });
});
