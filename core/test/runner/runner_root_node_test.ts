/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';

async function runToCompletion(
  root: ConstructorParameters<typeof Runner>[0]['agent'],
) {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'app',
    userId: 'u',
  });
  const runner = new Runner({appName: 'app', agent: root, sessionService});
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  return {events, runner};
}

describe('Runner with a workflow as its root', () => {
  it('runs a bare Workflow without it being wrapped by hand', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node((_ctx, input) => `saw:${input}`, {name: 'step'})]],
    });

    const {events, runner} = await runToCompletion(workflow);

    // Driven as a node, not adapted into an agent: the runner holds the very
    // workflow it was given.
    expect(runner.agent).toBe(workflow);
    expect(events.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      'saw:go',
    ]);
  });

  it('leaves the invocation without an agent when the root is a node', async () => {
    // There is no agent at this level, and saying so is what removes the need
    // to manufacture one. Nodes deeper in the graph that are agents get their
    // own contexts.
    let seen: InvocationContext | undefined;
    const workflow = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(
            (ctx: NodeContext) => {
              seen = ctx.invocationContext;
              return 'done';
            },
            {name: 'step'},
          ),
        ],
      ],
    });

    await runToCompletion(workflow);

    expect(seen).toBeDefined();
    expect(seen!.agent).toBeUndefined();
  });

  it('leaves an explicitly wrapped workflow alone', async () => {
    const agent = new Workflow({
      name: 'explicit',
      edges: [['START', node(() => 'done', {name: 'step'})]],
    });

    const runner = new Runner({
      appName: 'app',
      agent,
      sessionService: new InMemorySessionService(),
    });

    expect(runner.agent).toBe(agent);
  });

  it('runs a lone node as a one-node workflow', async () => {
    // Same set an edge accepts: the node becomes the single node of a one-node
    // workflow, so `{agent: node}` and `{agent: new Workflow({edges: [['START',
    // node]]})}` are the same request spelled two ways.
    const lone = new FunctionNode('lonely', (_ctx, input) => `saw:${input}`);

    const {events} = await runToCompletion(lone);

    expect(events.flatMap((e) => e.content?.parts ?? [])).toContainEqual(
      expect.objectContaining({text: 'saw:go'}),
    );
  });

  it('refuses a value that is not node-like', () => {
    expect(
      () =>
        new Runner({
          appName: 'app',
          // Rejected by the type system too; the cast is what lets the runtime
          // guard be exercised.
          agent: {name: 'fake'} as unknown as Workflow,
          sessionService: new InMemorySessionService(),
        }),
    ).toThrow(/expected a BaseAgent, a Workflow, or a node-like value/);
  });
});
