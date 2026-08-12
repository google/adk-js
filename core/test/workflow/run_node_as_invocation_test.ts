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
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  asRunnableRoot,
  runNodeAsInvocation,
} from '../../src/workflow/run_node_as_invocation.js';
import {createRequestInputEvent} from '../../src/workflow/utils/hitl_utils.js';
import {isWorkflow, Workflow} from '../../src/workflow/workflow.js';
import {ReplyAgent} from './test_helpers.js';

/** A session event standing in for a node that raised an unresolved interrupt. */
function pendingInterruptEvent(id: string): Event {
  const event = createRequestInputEvent(
    new RequestInput({interruptId: id, message: '?'}),
  );
  event.author = id;
  // The engine stamps the emitting node's path onto every node event; carry it
  // here too, since run scoping uses it to tell node events from plain
  // conversation turns.
  event.nodeInfo = {path: `capture.${id}`};
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
    userContent: {role: 'user', parts: [{text: replyText}]},
    pluginManager: new PluginManager(),
  });

  for await (const _ of runNodeAsInvocation(wf, ic)) {
    void _;
  }
  return captured;
}

describe('runNodeAsInvocation — plain-text resume', () => {
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

async function runWorkflow(workflow: Workflow): Promise<Event[]> {
  const ic = new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      lastUpdateTime: Date.now(),
    }),
    userContent: {role: 'user', parts: [{text: 'go'}]},
    pluginManager: new PluginManager(),
  });
  const events: Event[] = [];
  for await (const event of runNodeAsInvocation(workflow, ic)) {
    events.push(event);
  }
  return events;
}

describe('asRunnableRoot — takes what edges take', () => {
  it('makes a bare function the one node of a one-node workflow', async () => {
    function greet() {
      return 'hello';
    }
    const root = asRunnableRoot(greet);

    expect(isWorkflow(root)).toBe(true);
    expect(root.name).toBe('greet');
    expect((root as Workflow).graph?.nodes.map((n) => n.name)).toEqual([
      '__START__',
      'greet',
    ]);
    const withOutput = (await runWorkflow(root as Workflow)).filter(
      (e) => e.output !== undefined,
    );
    expect(withOutput.map((e) => e.output)).toEqual(['hello']);
  });

  it('passes an agent through as itself, with nothing wrapped around it', () => {
    const agent = new ReplyAgent('reply');

    expect(asRunnableRoot(agent)).toBe(agent);
  });

  it('passes a workflow through as itself', () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'x', {name: 'step'})]],
    });

    expect(asRunnableRoot(workflow)).toBe(workflow);
  });

  it('takes name and description from the built node', () => {
    const built = node(() => 'x', {name: 'built', description: 'from node'});

    expect(asRunnableRoot(built).name).toBe('built');
    expect(asRunnableRoot(built).description).toBe('from node');
  });

  it('refuses a value an edge would not accept', () => {
    expect(() => asRunnableRoot({name: 'fake'} as never)).toThrow(
      /expected a BaseAgent, a Workflow, or a node-like value/,
    );
  });
});

describe('runNodeAsInvocation — the workflow output reaches the caller once', () => {
  it('does not repeat the terminal node’s output', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'result', {name: 'only'})]],
    });

    const withOutput = (await runWorkflow(workflow)).filter(
      (e) => e.output !== undefined,
    );

    // The terminal node already emitted its output on the way past; announcing
    // it again would make one node output arrive as two data events.
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].author).toBe('only');
    expect(withOutput[0].output).toBe('result');
  });

  it('announces a dynamicEntry’s return value, which no node emitted', async () => {
    const workflow = new Workflow({
      name: 'dyn',
      dynamicEntry: async (ctx: NodeContext) => {
        const child = await ctx.runNode(
          node(() => 2, {name: 'double'}),
          null,
        );
        // Derived from the child rather than returned verbatim, so nothing on
        // the channel carries it.
        return (child.output as number) * 21;
      },
    });

    const withOutput = (await runWorkflow(workflow)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput.map((e) => e.output)).toEqual([2, 42]);
    expect(withOutput[1].author).toBe('dyn');
  });

  it('re-announces the result when a later node emitted after it', async () => {
    const workflow = new Workflow({
      name: 'later',
      dynamicEntry: async (ctx: NodeContext) => {
        const result = await ctx.runNode(
          node(() => 'headline', {name: 'make'}),
          null,
        );
        // A scoring pass runs after the value that becomes the result, so the
        // result is no longer the last output on the stream.
        await ctx.runNode(
          node(() => ({score: 9}), {name: 'grade'}),
          null,
        );
        return result.output;
      },
    });

    const withOutput = (await runWorkflow(workflow)).filter(
      (e) => e.output !== undefined,
    );

    // Without the trailing event, a consumer taking the last output would read
    // the score instead of the headline.
    expect(withOutput.map((e) => e.output)).toEqual([
      'headline',
      {score: 9},
      'headline',
    ]);
    expect(withOutput[2].author).toBe('later');
  });

  it('does not repeat a dynamicEntry’s value when a child already emitted it', async () => {
    const workflow = new Workflow({
      name: 'passthrough',
      dynamicEntry: async (ctx: NodeContext) => {
        const child = await ctx.runNode(
          node(() => 'x', {name: 'inner'}),
          null,
        );
        return child.output;
      },
    });

    const withOutput = (await runWorkflow(workflow)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].author).toBe('inner');
  });

  it('announces a terminal node’s output that was set without emitting', async () => {
    const workflow = new Workflow({
      name: 'assigns',
      edges: [
        [
          'START',
          node(
            (ctx: NodeContext) => {
              // Assigning rather than returning: nothing is yielded, so no
              // event carries this value out.
              ctx.output = 'assigned';
            },
            {name: 'quiet'},
          ),
        ],
      ],
    });

    const withOutput = (await runWorkflow(workflow)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].output).toBe('assigned');
    expect(withOutput[0].author).toBe('assigns');
  });
});
