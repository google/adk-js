/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {
  BasePolicyEngine,
  PolicyOutcome,
  SecurityPlugin,
} from '../../src/plugins/security_plugin.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';

function makeToolContext(functionCallId: string) {
  const stateStore: Record<string, unknown> = {};
  const toolContext = {
    functionCallId,
    state: {
      get: (key: string) => stateStore[key],
      set: (key: string, value: unknown) => {
        stateStore[key] = value;
      },
    },
    toolConfirmation: undefined as ToolConfirmation | undefined,
    requestConfirmation: () => {},
  } as unknown as Context;
  return {toolContext, stateStore};
}

const tool = {name: 'dangerous_tool'} as BaseTool;

function engine(outcome: string, counter?: {n: number}): BasePolicyEngine {
  return {
    evaluate: async () => {
      if (counter) counter.n++;
      return {outcome, reason: 'test'};
    },
  };
}

describe('SecurityPlugin — recorded decisions are replayed, not discarded', () => {
  it('keeps denying a tool call that the policy engine denied', async () => {
    const calls = {n: 0};
    const plugin = new SecurityPlugin({
      policyEngine: engine(PolicyOutcome.DENY, calls),
    });
    const {toolContext} = makeToolContext('fc-deny');

    const first = await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext,
    });
    const second = await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext,
    });

    expect(first).toHaveProperty('error');
    // Previously the recorded DENY was not CONFIRM, so it fell through to
    // undefined, which the callback contract treats as "allow execution".
    expect(second).toHaveProperty('error');
    expect(calls.n).toBe(1);
  });

  it('keeps allowing a tool call that the policy engine allowed', async () => {
    const calls = {n: 0};
    const plugin = new SecurityPlugin({
      policyEngine: engine(PolicyOutcome.ALLOW, calls),
    });
    const {toolContext} = makeToolContext('fc-allow');

    expect(
      await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext}),
    ).toBeUndefined();
    expect(
      await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext}),
    ).toBeUndefined();
    expect(calls.n).toBe(1);
  });

  it('keeps rejecting after the user rejected the confirmation', async () => {
    const plugin = new SecurityPlugin({
      policyEngine: engine(PolicyOutcome.CONFIRM),
    });
    const {toolContext} = makeToolContext('fc-rejected');

    await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext});

    toolContext.toolConfirmation = {confirmed: false} as ToolConfirmation;
    const rejected = await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext,
    });
    expect(rejected).toEqual({
      error: 'Tool call rejected from confirmation flow.',
    });

    // A later evaluation of the same call must not turn the rejection into an
    // approval.
    toolContext.toolConfirmation = undefined;
    expect(
      await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext}),
    ).toEqual({error: 'Tool call rejected from confirmation flow.'});
  });

  it('stays allowed after the user approved the confirmation', async () => {
    const plugin = new SecurityPlugin({
      policyEngine: engine(PolicyOutcome.CONFIRM),
    });
    const {toolContext} = makeToolContext('fc-approved');

    await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext});

    toolContext.toolConfirmation = {confirmed: true} as ToolConfirmation;
    expect(
      await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext}),
    ).toBeUndefined();

    toolContext.toolConfirmation = undefined;
    expect(
      await plugin.beforeToolCallback({tool, toolArgs: {}, toolContext}),
    ).toBeUndefined();
  });

  it('re-evaluates an unrecognised recorded state instead of proceeding on it', async () => {
    const calls = {n: 0};
    const plugin = new SecurityPlugin({
      policyEngine: engine(PolicyOutcome.DENY, calls),
    });
    const {toolContext, stateStore} = makeToolContext('fc-garbage');

    stateStore['orcas_tool_call_security_check_states'] = {
      'fc-garbage': 'NOT_A_REAL_OUTCOME',
    };

    const result = await plugin.beforeToolCallback({
      tool,
      toolArgs: {},
      toolContext,
    });
    expect(result).toHaveProperty('error');
    expect(calls.n).toBe(1);
  });
});
