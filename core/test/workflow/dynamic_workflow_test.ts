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
  DynamicNodeScheduler,
  FunctionNode,
  NodeStatus,
  runNode,
} from '../../src/workflow/index.js';

describe('Workflow DynamicNodeScheduler & runNode', () => {
  function createTestContext(
    params?: Partial<InvocationContext>,
  ): InvocationContext {
    const session: Session = {
      id: 'session-dyn',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state: {},
    };

    return new InvocationContext({
      invocationId: 'inv-dyn',
      session,
      agent: {
        name: 'mock_agent',
        runAsync: async function* () {},
      } as unknown as BaseAgent,
      pluginManager: new PluginManager(),
      ...params,
    });
  }

  it('should run dynamic workflows and track individual node checkpoints via runNode', async () => {
    const ctx = createTestContext();
    const nodeA = new FunctionNode('calc_a', (_ctx, num: number) => num * 2);
    const nodeB = new FunctionNode('calc_b', (_ctx, num: number) => num + 10);

    const dynamicEntry = async (context: InvocationContext, input?: number) => {
      const resA = await runNode(context, nodeA, input || 5);
      if (resA > 5) {
        const resB = await runNode(context, nodeB, resA);
        return resB;
      }
      return resA;
    };

    const scheduler = new DynamicNodeScheduler(dynamicEntry, {
      outputKey: 'dynResult',
    });
    for await (const _ of scheduler.runAsync(ctx, 4)) {
      /* consume events */
    }

    expect(ctx.agentStates['exec_node_calc_a'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_calc_a'].outputPayload).toBe(8);
    expect(ctx.agentStates['exec_node_calc_b'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_calc_b'].outputPayload).toBe(18);
    expect(ctx.agentStates['dynResult']).toBe(18);
  });

  it('should skip completed nodes inside dynamic execution on resume', async () => {
    const ctx = createTestContext();
    const spyA = vi.fn((_ctx, num: number) => num * 100);
    const spyB = vi.fn((_ctx, num: number) => num + 50);
    const nodeA = new FunctionNode('node_dyn_a', spyA, {rerunOnResume: false});
    const nodeB = new FunctionNode('node_dyn_b', spyB, {rerunOnResume: true});

    ctx.agentStates['exec_node_node_dyn_a'] = {
      executionId: 'exec_node_node_dyn_a',
      nodeName: 'node_dyn_a',
      status: NodeStatus.COMPLETED,
      outputPayload: 999,
      timestamp: Date.now(),
    };

    const dynamicEntry = async (context: InvocationContext, input?: number) => {
      const resA = await runNode(context, nodeA, input || 1);
      const resB = await runNode(context, nodeB, resA);
      return resB;
    };

    const scheduler = new DynamicNodeScheduler(dynamicEntry);
    for await (const _ of scheduler.runAsync(ctx, 2)) {
      /* consume events */
    }

    // spyA skipped, reused 999
    expect(spyA).not.toHaveBeenCalled();
    // spyB executed with 999
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledWith(ctx, 999);
  });
});
