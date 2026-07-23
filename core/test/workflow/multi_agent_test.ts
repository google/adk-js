/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {EventChannel} from '../../src/workflow/utils/event_channel.js';
import {Workflow} from '../../src/workflow/workflow.js';

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

async function driveWorkflow(
  wf: Workflow,
  input?: unknown,
): Promise<{output: unknown; events: Event[]}> {
  const channel = new EventChannel<Event>();
  const root = new NodeContext({
    invocationContext: createIc(),
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(wf, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const e of channel) {
    events.push(e);
  }
  await settle;
  return {output: root.output, events};
}

/** A fake agent that emits a fixed model text and optionally transfers. */
class ScriptedAgent extends BaseAgent {
  constructor(
    name: string,
    private readonly text: string,
    private readonly transferTo?: string,
    subAgents: BaseAgent[] = [],
  ) {
    super({name, subAgents});
  }
  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    if (this.transferTo) {
      yield createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        actions: {transferToAgent: this.transferTo},
      });
      return;
    }
    yield createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: this.text}]},
    });
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

describe('Phase 7b — multi-agent hand-off (transfer_to_agent)', () => {
  it('follows a transfer to a peer agent and uses its output', async () => {
    const specialist = new ScriptedAgent('specialist', 'specialist-answer');
    const coordinator = new ScriptedAgent(
      'coordinator',
      '(unused)',
      'specialist',
      [specialist],
    );

    const wf = new Workflow({
      name: 'transfer_wf',
      edges: [['START', coordinator]],
    });
    const {output, events} = await driveWorkflow(wf, 'question');

    expect(output).toBe('specialist-answer');
    // Both the coordinator's transfer event and the specialist's answer stream.
    expect(
      events.some((e) => e.actions?.transferToAgent === 'specialist'),
    ).toBe(true);
    expect(events.some((e) => e.author === 'specialist')).toBe(true);
  });

  it('follows a chain of transfers', async () => {
    const c = new ScriptedAgent('c_agent', 'final');
    const b = new ScriptedAgent('b_agent', '(unused)', 'c_agent', [c]);
    const a = new ScriptedAgent('a_agent', '(unused)', 'b_agent', [b]);

    const wf = new Workflow({name: 'chain_wf', edges: [['START', a]]});
    expect((await driveWorkflow(wf, 'x')).output).toBe('final');
  });
});

describe('Phase 7b — multi-agent orchestration via ctx.runNode', () => {
  it('coordinates specialist agents imperatively (node-as-tool)', async () => {
    const researcher = new ScriptedAgent('researcher', 'facts');
    const writer = new ScriptedAgent('writer', 'report');

    // Idiomatic TS multi-agent: a coordinator drives sub-agents via runNode.
    const wf = new Workflow({
      name: 'coordinator_wf',
      dynamicEntry: async (ctx, input) => {
        const research = await ctx.runNode(node(researcher), input);
        const draft = await ctx.runNode(node(writer), research.output);
        return {research: research.output, draft: draft.output};
      },
    });

    expect(await driveWorkflow(wf, 'topic').then((r) => r.output)).toEqual({
      research: 'facts',
      draft: 'report',
    });
  });
});
