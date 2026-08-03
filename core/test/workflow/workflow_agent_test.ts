/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {createRequestInputEvent} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

/** A session event standing in for a node that raised an unresolved interrupt. */
function pendingInterruptEvent(id: string): Event {
  const event = createRequestInputEvent(
    new RequestInput({interruptId: id, message: '?'}),
  );
  event.author = id;
  return event;
}

/**
 * Runs the agent against a session pre-seeded with `pendingIds` unresolved
 * interrupts and a plain-text user reply, returning the `resumeInputs` the
 * workflow was driven with (captured via a dynamicEntry).
 */
async function resumeInputsFor(
  pendingIds: string[],
  replyText: string,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  const wf = new Workflow({
    name: 'capture',
    dynamicEntry: async (ctx: NodeContext) => {
      captured = {...ctx.resumeInputs};
      return 'done';
    },
  });
  const agent = new WorkflowAgent(wf);

  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    lastUpdateTime: Date.now(),
  });
  for (const id of pendingIds) {
    session.events.push(pendingInterruptEvent(id));
  }

  const ic = new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent,
    userContent: {role: 'user', parts: [{text: replyText}]},
    pluginManager: new PluginManager(),
  });

  for await (const _ of agent.runAsync(ic)) {
    void _;
  }
  return captured;
}

describe('WorkflowAgent — plain-text resume', () => {
  it('feeds a plain-text reply to the single pending interrupt', async () => {
    expect(await resumeInputsFor(['only'], 'yes')).toEqual({only: 'yes'});
  });

  it('ignores a plain-text reply when multiple interrupts are pending', async () => {
    // Broadcasting one answer to every pause would resume a node with data the
    // user never gave it; the ambiguous case is dropped (structured function
    // responses are required to address a specific interrupt).
    expect(await resumeInputsFor(['first', 'second'], 'yes')).toEqual({});
  });
});
