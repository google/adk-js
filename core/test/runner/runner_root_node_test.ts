/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {WorkflowAgent} from '../../src/workflow/workflow_agent.js';

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

    // Wrapped internally, so the rest of the runner keeps seeing an agent.
    expect(runner.agent).toBeInstanceOf(WorkflowAgent);
    expect(runner.agent.name).toBe('wf');
    expect(events.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      'saw:go',
    ]);
  });

  it('leaves an explicitly wrapped workflow alone', async () => {
    const agent = new WorkflowAgent({
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
    // Same set `WorkflowAgent` accepts: the node becomes the single node of a
    // one-node workflow, so `{agent: node}` and `{agent: new
    // WorkflowAgent(node)}` are the same request spelled two ways.
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
          agent: {name: 'fake'} as never,
          sessionService: new InMemorySessionService(),
        }),
    ).toThrow(/expected a BaseAgent, a Workflow, or a node-like value/);
  });
});
