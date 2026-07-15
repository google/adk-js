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
  createRequestInputEvent,
  FunctionNode,
  injectHitlResumptionInput,
  NodeRunner,
  NodeStatus,
  persistAgentStatesToSession,
  rehydrateAgentStates,
  ReplayManager,
} from '../../src/workflow/index.js';

describe('Workflow HITL & State Rehydration', () => {
  function createTestContext(session?: Session): InvocationContext {
    const s: Session = session || {
      id: 'session-hitl',
      appName: 'test-app',
      userId: 'test-user',
      events: [],
      state: {},
    };

    return new InvocationContext({
      invocationId: 'inv-hitl',
      session: s,
      agent: {
        name: 'mock_agent',
        runAsync: async function* () {},
      } as unknown as BaseAgent,
      pluginManager: new PluginManager(),
    });
  }

  it('should pause workflow execution when a node yields a RequestInput event', async () => {
    const ctx = createTestContext();
    const hitlNode = new FunctionNode('approval_step', (context) => {
      return createRequestInputEvent(context, 'approval_step', {
        prompt: 'Please approve this transaction (yes/no)',
      });
    });
    const downstreamNode = new FunctionNode('post_approval', () => 'EXECUTED');

    const runner = new NodeRunner([['START', hitlNode, downstreamNode]]);
    const events: unknown[] = [];
    for await (const ev of runner.runAsync(ctx)) {
      events.push(ev);
    }

    expect(events.length).toBe(1);
    expect(
      (
        events[0] as unknown as Record<
          string,
          Record<string, {nodeName: string}>
        >
      ).actions.requestInput.nodeName,
    ).toBe('approval_step');
    expect(ctx.agentStates['exec_node_approval_step'].status).toBe(
      NodeStatus.PAUSED_HITL,
    );

    expect(ctx.endInvocation).toBe(true);
    // downstreamNode must NOT have run while paused
    expect(ctx.agentStates['exec_node_post_approval']).toBeUndefined();
  });

  it('should inject resumption input and complete the paused node on subsequent turn', async () => {
    const ctx = createTestContext();
    const hitlNode = new FunctionNode(
      'approval_step',
      (_context, input?: string) => {
        if (!input) {
          return createRequestInputEvent(_context, 'approval_step', {
            prompt: 'Approve?',
          });
        }
        return `APPROVED_WITH_${input}`;
      },
    );
    const downstreamNode = new FunctionNode(
      'post_approval',
      (_context, input: string) => `DONE_${input}`,
    );

    const runner = new NodeRunner([['START', hitlNode, downstreamNode]]);

    // Turn 1: Pauses
    for await (const _ of runner.runAsync(ctx)) {
      /* consume events */
    }
    expect(ctx.agentStates['exec_node_approval_step'].status).toBe(
      NodeStatus.PAUSED_HITL,
    );

    // Turn 2: User provides input 'YES'. Inject it and run again.
    ctx.endInvocation = false;
    const resumedInfo = injectHitlResumptionInput(ctx, 'YES');
    expect(resumedInfo?.nodeName).toBe('approval_step');
    expect(ctx.agentStates['exec_node_approval_step'].status).toBe(
      NodeStatus.RUNNING,
    );
    expect(ctx.agentStates['exec_node_approval_step'].inputPayload).toBe('YES');

    for await (const _ of runner.runAsync(ctx)) {
      /* consume events */
    }

    expect(ctx.agentStates['exec_node_approval_step'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_approval_step'].outputPayload).toBe(
      'APPROVED_WITH_YES',
    );
    expect(ctx.agentStates['exec_node_post_approval'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx.agentStates['exec_node_post_approval'].outputPayload).toBe(
      'DONE_APPROVED_WITH_YES',
    );
  });

  it('should persist and rehydrate checkpoints from session state accurately', () => {
    const session: Session = {
      id: 's-rehydrate',
      appName: 'app',
      userId: 'user',
      events: [],
      state: {},
    };
    const ctx1 = createTestContext(session);
    ctx1.agentStates['exec_node_saved'] = {
      executionId: 'exec_node_saved',
      nodeName: 'saved',
      status: NodeStatus.COMPLETED,
      outputPayload: {foo: 'bar'},
      timestamp: 12345,
    };
    ctx1.endOfAgents['my_wf'] = true;

    persistAgentStatesToSession(ctx1, session);

    // Now simulate a fresh context loading from the same session
    const ctx2 = createTestContext(session);
    rehydrateAgentStates(session, ctx2);

    expect(ctx2.agentStates['exec_node_saved'].status).toBe(
      NodeStatus.COMPLETED,
    );
    expect(ctx2.agentStates['exec_node_saved'].outputPayload).toEqual({
      foo: 'bar',
    });
    expect(ctx2.endOfAgents['my_wf']).toBe(true);
  });

  it('should yield historical replay events when ReplayManager inspects completed checkpoints', async () => {
    const ctx = createTestContext();
    const node = new FunctionNode('past_node', () => 'historical_res', {
      rerunOnResume: false,
    });
    ctx.agentStates['exec_node_past_node'] = {
      executionId: 'exec_node_past_node',
      nodeName: 'past_node',
      status: NodeStatus.COMPLETED,
      outputPayload: 'historical_res',
      timestamp: 99999,
    };

    const gen = ReplayManager.replayIfCompleted(ctx, node);
    const ev = await gen.next();
    expect(ev.done).toBe(false);
    expect(ev.value.actions.nodeExecutionReplay.outputPayload).toBe(
      'historical_res',
    );

    const res = await gen.next();
    expect(res.done).toBe(true);
    expect(res.value).toBe(true); // Replayed successfully, skip real run
  });
});
