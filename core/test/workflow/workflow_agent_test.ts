/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {LoopAgent} from '../../src/agents/loop_agent.js';
import {ParallelAgent} from '../../src/agents/parallel_agent.js';
import {SequentialAgent} from '../../src/agents/sequential_agent.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {isBaseNode} from '../../src/workflow/base_node.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {createRequestInputEvent} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {
  isGraphWorkflowAgent,
  WorkflowAgent,
} from '../../src/workflow/workflow_agent.js';

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

describe('WorkflowAgent — constructor forms', () => {
  const step = node(() => 'done', {name: 'step'});

  it('builds the Workflow from config (the convenience signature)', () => {
    const agent = new WorkflowAgent({
      name: 'from_config',
      edges: [['START', step]],
    });
    expect(agent.name).toBe('from_config');
    expect(isBaseNode(agent.workflow)).toBe(true);
    expect(agent.workflow.name).toBe('from_config');
  });

  it('accepts a dynamicEntry config too', () => {
    const agent = new WorkflowAgent({
      name: 'dyn',
      dynamicEntry: async () => 'ok',
    });
    expect(agent.workflow.name).toBe('dyn');
  });

  it('still accepts a pre-built Workflow, with optional overrides', () => {
    const workflow = new Workflow({name: 'wf', edges: [['START', step]]});
    expect(new WorkflowAgent(workflow).name).toBe('wf');
    expect(new WorkflowAgent(workflow).workflow).toBe(workflow);
    expect(new WorkflowAgent(workflow, {name: 'override'}).name).toBe(
      'override',
    );
  });
});

/** Runs an agent to completion and returns every event it yielded. */
async function runAgent(agent: WorkflowAgent): Promise<Event[]> {
  const ic = new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({
      id: 's1',
      appName: 'app',
      userId: 'u',
      lastUpdateTime: Date.now(),
    }),
    agent,
    userContent: {role: 'user', parts: [{text: 'go'}]},
    pluginManager: new PluginManager(),
  });
  const events: Event[] = [];
  for await (const event of agent.runAsync(ic)) {
    events.push(event);
  }
  return events;
}

describe('WorkflowAgent — the workflow output reaches the caller once', () => {
  it('does not repeat the terminal node’s output', async () => {
    const agent = new WorkflowAgent({
      name: 'wf',
      edges: [['START', node(() => 'result', {name: 'only'})]],
    });

    const withOutput = (await runAgent(agent)).filter(
      (e) => e.output !== undefined,
    );

    // The terminal node already emitted its output on the way past; announcing
    // it again would make one node output arrive as two data events.
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].author).toBe('only');
    expect(withOutput[0].output).toBe('result');
  });

  it('announces a dynamicEntry’s return value, which no node emitted', async () => {
    const agent = new WorkflowAgent({
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

    const withOutput = (await runAgent(agent)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput.map((e) => e.output)).toEqual([2, 42]);
    expect(withOutput[1].author).toBe('dyn');
  });

  it('re-announces the result when a later node emitted after it', async () => {
    const agent = new WorkflowAgent({
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

    const withOutput = (await runAgent(agent)).filter(
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
    const agent = new WorkflowAgent({
      name: 'passthrough',
      dynamicEntry: async (ctx: NodeContext) => {
        const child = await ctx.runNode(
          node(() => 'x', {name: 'inner'}),
          null,
        );
        return child.output;
      },
    });

    const withOutput = (await runAgent(agent)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].author).toBe('inner');
  });

  it('announces a terminal node’s output that was set without emitting', async () => {
    const agent = new WorkflowAgent({
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

    const withOutput = (await runAgent(agent)).filter(
      (e) => e.output !== undefined,
    );

    expect(withOutput).toHaveLength(1);
    expect(withOutput[0].output).toBe('assigned');
    expect(withOutput[0].author).toBe('assigns');
  });
});

describe('isGraphWorkflowAgent', () => {
  const step = node(() => 'done', {name: 'step'});

  it('recognises a graph WorkflowAgent', () => {
    const agent = new WorkflowAgent(
      new Workflow({name: 'wf', edges: [['START', step]]}),
    );
    expect(isGraphWorkflowAgent(agent)).toBe(true);
  });

  it('recognises a branded agent from another package copy', () => {
    const fromOtherCopy = {
      [Symbol.for('google.adk.workflow.workflowAgent')]: true,
    };
    expect(isGraphWorkflowAgent(fromOtherCopy)).toBe(true);
  });

  it('rejects the v1 workflow agents and a plain LlmAgent', () => {
    expect(
      isGraphWorkflowAgent(
        new SequentialAgent({
          name: 'seq',
          subAgents: [new LlmAgent({name: 'sub_seq'})],
        }),
      ),
    ).toBe(false);
    expect(
      isGraphWorkflowAgent(
        new ParallelAgent({
          name: 'par',
          subAgents: [new LlmAgent({name: 'sub_par'})],
        }),
      ),
    ).toBe(false);
    expect(
      isGraphWorkflowAgent(
        new LoopAgent({
          name: 'loop',
          subAgents: [new LlmAgent({name: 'sub_loop'})],
        }),
      ),
    ).toBe(false);
    expect(isGraphWorkflowAgent(new LlmAgent({name: 'llm'}))).toBe(false);
  });

  it('rejects the wrapped workflow itself and non-objects', () => {
    expect(
      isGraphWorkflowAgent(
        new Workflow({name: 'wf', edges: [['START', step]]}),
      ),
    ).toBe(false);
    expect(isGraphWorkflowAgent(undefined)).toBe(false);
    expect(isGraphWorkflowAgent(null)).toBe(false);
    expect(isGraphWorkflowAgent('wf')).toBe(false);
  });
});
