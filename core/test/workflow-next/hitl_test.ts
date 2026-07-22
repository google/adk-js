/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {NodeContext} from '../../src/workflow-next/node_context.js';
import {FunctionNode} from '../../src/workflow-next/nodes/function_node.js';
import {RequestInput} from '../../src/workflow-next/request_input.js';
import {EventChannel} from '../../src/workflow-next/utils/event_channel.js';
import {
  hasRequestInputFunctionCall,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../src/workflow-next/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow-next/workflow.js';

function createIc(): InvocationContext {
  const session = {
    id: 's1',
    appName: 'app',
    userId: 'u',
    events: [],
    state: {},
    lastUpdateTime: Date.now(),
  } as unknown as Session;
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: {
      name: 'wf',
      runAsync: async function* () {},
    } as unknown as BaseAgent,
    pluginManager: new PluginManager(),
  });
}

/**
 * Drives a workflow, optionally supplying resume inputs (keyed by interrupt id).
 * Returns the workflow output, its interrupt ids, and the streamed events.
 */
async function drive(
  wf: Workflow,
  input?: unknown,
  resumeInputs: Record<string, unknown> = {},
): Promise<{output: unknown; interruptIds: string[]; events: Event[]}> {
  const channel = new EventChannel<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
    resumeInputs,
  });
  const events: Event[] = [];
  const wfCtxPromise = root.runNode(wf, input, {useAsOutput: true});
  const settle = wfCtxPromise.then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  const wfCtx = await wfCtxPromise;
  return {output: root.output, interruptIds: wfCtx.interruptIds, events};
}

describe('Phase 5 — HITL (pause / resume)', () => {
  it('pauses on RequestInput and surfaces the interrupt id', async () => {
    const approval = new FunctionNode('approval', (ctx) => {
      const answer = ctx.resumeInputs['approve-1'];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: 'approve-1',
          message: 'Approve?',
        });
      }
      return `decided:${answer}`;
    });
    const wf = new Workflow({name: 'hitl', edges: [['START', approval]]});

    // Run 1: no resume input → interrupt.
    const paused = await drive(wf, undefined);
    expect(paused.interruptIds).toEqual(['approve-1']);
    expect(paused.output).toBeUndefined();
    // The interrupt surfaced as a request_input function-call event.
    expect(paused.events.some(hasRequestInputFunctionCall)).toBe(true);
    const fc = paused.events
      .flatMap((e) => e.content?.parts ?? [])
      .find((p) => p.functionCall?.name === REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(fc?.functionCall?.id).toBe('approve-1');
  });

  it('resumes and completes when the resume input is provided', async () => {
    const approval = new FunctionNode('approval', (ctx) => {
      const answer = ctx.resumeInputs['approve-1'];
      if (answer === undefined) {
        return new RequestInput({
          interruptId: 'approve-1',
          message: 'Approve?',
        });
      }
      return `decided:${answer}`;
    });
    const wf = new Workflow({name: 'hitl', edges: [['START', approval]]});

    // Run 2: provide the resume input → completes.
    const resumed = await drive(wf, undefined, {'approve-1': 'yes'});
    expect(resumed.interruptIds).toEqual([]);
    expect(resumed.output).toBe('decided:yes');
  });

  it('propagates an interrupt from a mid-graph node and halts downstream', async () => {
    const ran: string[] = [];
    const a = new FunctionNode('a', (_c, input) => {
      ran.push('a');
      return `a:${input}`;
    });
    const gate = new FunctionNode('gate', (ctx, input) => {
      ran.push('gate');
      const answer = ctx.resumeInputs['gate-1'];
      if (answer === undefined) {
        return new RequestInput({interruptId: 'gate-1', message: 'continue?'});
      }
      return `${input}|gate:${answer}`;
    });
    const c = new FunctionNode('c', (_c, input) => {
      ran.push('c');
      return `c:${input}`;
    });
    const wf = new Workflow({name: 'chain', edges: [['START', a, gate, c]]});

    const paused = await drive(wf, 'x');
    expect(paused.interruptIds).toEqual(['gate-1']);
    // Downstream node c must NOT have run while gate is waiting.
    expect(ran).toEqual(['a', 'gate']);

    const resumed = await drive(wf, 'x', {'gate-1': 'ok'});
    expect(resumed.output).toBe('c:a:x|gate:ok');
  });

  it('supports HITL in an imperative dynamicEntry workflow', async () => {
    const ask = new FunctionNode('ask', (ctx) => {
      const answer = ctx.resumeInputs['name'];
      if (answer === undefined) {
        return new RequestInput({interruptId: 'name', message: 'Your name?'});
      }
      return answer;
    });
    const wf = new Workflow({
      name: 'dyn_hitl',
      dynamicEntry: async (ctx) => {
        const child = await ctx.runNode(ask);
        if (child.interruptIds.length > 0) {
          return undefined; // still waiting
        }
        return `hello ${child.output}`;
      },
    });

    const paused = await drive(wf);
    expect(paused.interruptIds).toEqual(['name']);

    const resumed = await drive(wf, undefined, {name: 'Ada'});
    expect(resumed.output).toBe('hello Ada');
  });
});
