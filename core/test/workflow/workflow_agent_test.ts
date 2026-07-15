/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';

import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {
  FunctionNode,
  isWorkflow,
  NodeStatus,
  Workflow,
} from '../../src/workflow/index.js';

describe('Workflow Agent Orchestrator (`Workflow`)', () => {
  function createTestContext(
    params?: Partial<InvocationContext>,
  ): InvocationContext {
    const session: Session = {
      id: 'session-wf',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state: {},
    };

    return new InvocationContext({
      invocationId: 'inv-wf',
      session,
      agent: {
        name: 'mock_parent',
        runAsync: async function* () {},
      } as unknown as BaseAgent,
      pluginManager: new PluginManager(),
      ...params,
    });
  }

  it('should identify Workflow instances accurately via isWorkflow type guard', () => {
    const wf = new Workflow({
      name: 'test_wf',
      edges: [['START', new FunctionNode('a', () => 'a')]],
    });

    expect(isWorkflow(wf)).toBe(true);
    expect(isWorkflow({name: 'not_wf'})).toBe(false);
  });

  it('should throw an error if both or neither of edges and dynamicEntry are defined', () => {
    expect(() => new Workflow({name: 'empty_wf'})).toThrowError(
      /must define either "edges"/i,
    );

    expect(
      () =>
        new Workflow({
          name: 'conflicted_wf',
          edges: [['START', new FunctionNode('a', () => 'a')]],
          dynamicEntry: async () => 'b',
        }),
    ).toThrowError(/cannot have both "edges" and "dynamicEntry" defined/i);
  });

  it('should run a static graph Workflow from runAsync and mark endOfAgents upon completion', async () => {
    const ctx = createTestContext();
    const nodeA = new FunctionNode('step_first', () => 'First');
    const nodeB = new FunctionNode(
      'step_second',
      (_ctx, input: string) => `${input}_Second`,
    );

    const wf = new Workflow({
      name: 'static_wf',
      edges: [['START', nodeA, nodeB]],
      outputKey: 'wfResult',
    });

    for await (const _ of wf.runAsync(ctx)) {
      /* consume events */
    }

    expect(ctx.agentStates['exec_node_step_first'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_step_second'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['wfResult']).toEqual({
      step_first: 'First',
      step_second: 'First_Second',
    });
    expect(ctx.endOfAgents['static_wf']).toBe(true);
  });

  it('should run a dynamic Workflow from runAsync and mark endOfAgents upon completion', async () => {
    const ctx = createTestContext();
    const spy = vi.fn(async (_ctx, input: number) => input * 5);
    const dynNode = new FunctionNode('dyn_mul', spy);

    const wf = new Workflow({
      name: 'dynamic_wf',
      dynamicEntry: dynNode,
      outputKey: 'dynOut',
    });

    // Provide initial input via userContent text
    ctx.userContent = {role: 'user', parts: [{text: '10'}]};

    for await (const _ of wf.runAsync(ctx)) {
      /* consume events */
    }

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({role: 'user', parts: [{text: '10'}]});
    expect(ctx.agentStates['dynOut']).toBeDefined();
    expect(ctx.endOfAgents['dynamic_wf']).toBe(true);
  });

  it('should skip execution if context.endOfAgents already marks the workflow as true', async () => {
    const ctx = createTestContext();
    const spy = vi.fn(() => 'should_not_run');
    const wf = new Workflow({
      name: 'already_done_wf',
      edges: [['START', new FunctionNode('step_never', spy)]],
    });

    ctx.endOfAgents['already_done_wf'] = true;

    for await (const _ of wf.runAsync(ctx)) {
      /* consume events */
    }

    expect(spy).not.toHaveBeenCalled();
    expect(ctx.agentStates['exec_node_step_never']).toBeUndefined();
  });
});
