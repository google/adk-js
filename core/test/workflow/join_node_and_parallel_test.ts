/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {
  FunctionNode,
  JoinNode,
  NodeStatus,
  runInParallel,
} from '../../src/workflow/index.js';

describe('Workflow ParallelWorker & JoinNode', () => {
  function createTestContext(
    params?: Partial<InvocationContext>,
  ): InvocationContext {
    const session: Session = {
      id: 'session-par',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state: {},
    };

    return new InvocationContext({
      invocationId: 'inv-par',
      session,
      agent: {
        name: 'mock_agent',
        runAsync: async function* () {},
      } as unknown as BaseAgent,
      pluginManager: new PluginManager(),
      ...params,
    });
  }

  it('should run items in parallel and merge child checkpoints back into parent context', async () => {
    const ctx = createTestContext();
    const workerNode = new FunctionNode(
      'worker',
      async (_ctx, item: string) => {
        return `processed_${item}`;
      },
    );

    const results = await runInParallel(ctx, workerNode, [
      'alpha',
      'beta',
      'gamma',
    ]);

    expect(results).toEqual([
      'processed_alpha',
      'processed_beta',
      'processed_gamma',
    ]);
    expect(ctx.agentStates['exec_node_worker_0.worker'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_worker_0.worker'].outputPayload).toBe(
      'processed_alpha',
    );
    expect(ctx.agentStates['exec_node_worker_1.worker'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_worker_1.worker'].outputPayload).toBe(
      'processed_beta',
    );
    expect(ctx.agentStates['exec_node_worker_2.worker'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_worker_2.worker'].outputPayload).toBe(
      'processed_gamma',
    );
  });

  it('should synchronize at a JoinNode when all upstream predecessors reach COMPLETED', async () => {
    const ctx = createTestContext();
    const joinNode = new JoinNode('join_sync', {
      upstreamCount: 2,
      predecessors: ['branch_1', 'branch_2'],
    });

    // 1. First branch finishes, second has not started
    ctx.agentStates['exec_node_branch_1'] = {
      executionId: 'exec_node_branch_1',
      nodeName: 'branch_1',
      status: NodeStatus.COMPLETED,
      outputPayload: {data: 100},
      timestamp: Date.now(),
    };

    const gen1 = joinNode.run(ctx);
    const res1 = await gen1.next();
    // Since only 1 of 2 predecessors completed, joinNode returns partial state and does NOT yield a joinCompleted event
    expect(res1.done).toBe(true);
    expect(res1.value).toEqual({branch_1: {data: 100}});

    // 2. Second branch now finishes
    ctx.agentStates['exec_node_branch_2'] = {
      executionId: 'exec_node_branch_2',
      nodeName: 'branch_2',
      status: NodeStatus.COMPLETED,
      outputPayload: {data: 200},
      timestamp: Date.now(),
    };

    const gen2 = joinNode.run(ctx);
    const ev = await gen2.next(); // Should yield joinCompleted event
    expect(ev.done).toBe(false);
    expect(ev.value.actions.joinCompleted).toBeDefined();
    expect(ev.value.actions.joinCompleted.outputs).toEqual({
      branch_1: {data: 100},
      branch_2: {data: 200},
    });

    const finalRes = await gen2.next();
    expect(finalRes.done).toBe(true);
    expect(finalRes.value).toEqual({
      branch_1: {data: 100},
      branch_2: {data: 200},
    });
  });
});
