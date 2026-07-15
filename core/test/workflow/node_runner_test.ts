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
  NodeRunner,
  NodeStatus,
} from '../../src/workflow/index.js';

describe('Workflow NodeRunner & Checkpointing', () => {
  function createTestContext(
    params?: Partial<InvocationContext>,
  ): InvocationContext {
    const session: Session = {
      id: 'session-123',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state: {},
    };

    return new InvocationContext({
      invocationId: 'inv-456',
      session,
      agent: {
        name: 'mock_agent',
        runAsync: async function* () {},
      } as unknown as BaseAgent,
      pluginManager: new PluginManager(),
      ...params,
    });
  }

  it('should run sequential nodes and pass input payloads downstream', async () => {
    const ctx = createTestContext();
    const nodeA = new FunctionNode(
      'step_1',
      (_ctx, input: string) => `${input}_A`,
    );
    const nodeB = new FunctionNode(
      'step_2',
      (_ctx, input: string) => `${input}_B`,
    );

    const runner = new NodeRunner([['START', nodeA, nodeB]], {
      outputKey: 'finalOutput',
    });
    const events: unknown[] = [];
    for await (const event of runner.runAsync(ctx, 'INITIAL')) {
      events.push(event);
    }

    expect(ctx.agentStates['exec_node_step_1'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_step_1'].outputPayload).toBe('INITIAL_A');
    expect(ctx.agentStates['exec_node_step_2'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_step_2'].outputPayload).toBe(
      'INITIAL_A_B',
    );
    expect(ctx.agentStates['finalOutput']).toEqual({
      step_1: 'INITIAL_A',
      step_2: 'INITIAL_A_B',
    });
  });

  it('should route conditionally when a router node emits a route action or string', async () => {
    const ctx = createTestContext();
    const router = new FunctionNode('router', () => 'ROUTE_Y');
    const nodeX = new FunctionNode(
      'node_x',
      vi.fn(() => 'X'),
    );
    const nodeY = new FunctionNode(
      'node_y',
      vi.fn(() => 'Y'),
    );

    const runner = new NodeRunner([
      ['START', router],
      [router, {ROUTE_X: nodeX, ROUTE_Y: nodeY}],
    ]);

    for await (const _ of runner.runAsync(ctx)) {
      /* consume events */
    }

    expect(ctx.agentStates['exec_node_router'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_node_y'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_node_x']).toBeUndefined(); // ROUTE_X never enqueued
  });

  it('should skip completed nodes on resume unless rerunOnResume is true', async () => {
    const ctx = createTestContext();
    const spyA = vi.fn(() => 'fresh_A');
    const spyB = vi.fn(() => 'fresh_B');
    const nodeA = new FunctionNode('node_a', spyA, {rerunOnResume: false});
    const nodeB = new FunctionNode('node_b', spyB, {rerunOnResume: true});

    // Pre-populate agentStates as if nodeA and nodeB completed in a previous run
    ctx.agentStates['exec_node_node_a'] = {
      executionId: 'exec_node_node_a',
      nodeName: 'node_a',
      status: NodeStatus.COMPLETED,
      outputPayload: 'cached_A',
      timestamp: Date.now() - 10000,
    };
    ctx.agentStates['exec_node_node_b'] = {
      executionId: 'exec_node_node_b',
      nodeName: 'node_b',
      status: NodeStatus.COMPLETED,
      outputPayload: 'cached_B',
      timestamp: Date.now() - 10000,
    };

    const runner = new NodeRunner([['START', nodeA, nodeB]]);
    for await (const _ of runner.runAsync(ctx)) {
      /* consume events */
    }

    // nodeA should have been skipped (spyA not called), and cached_A passed to nodeB
    expect(spyA).not.toHaveBeenCalled();
    // nodeB has rerunOnResume: true, so spyB MUST be called with cached_A
    expect(spyB).toHaveBeenCalledTimes(1);
    expect(spyB).toHaveBeenCalledWith(ctx, 'cached_A');
  });

  it('should retry node execution upon transient errors according to retryConfig', async () => {
    const ctx = createTestContext();
    let attempts = 0;
    const flakyNode = new FunctionNode(
      'flaky_node',
      () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Transient timeout error');
        }
        return 'SUCCESS_AFTER_RETRY';
      },
      {
        retryConfig: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 50,
          backoffFactor: 1.5,
        },
      },
    );

    const runner = new NodeRunner([['START', flakyNode]]);
    for await (const _ of runner.runAsync(ctx)) {
      /* consume events */
    }

    expect(attempts).toBe(3);
    expect(ctx.agentStates['exec_node_flaky_node'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_flaky_node'].outputPayload).toBe(
      'SUCCESS_AFTER_RETRY',
    );
  });
});
