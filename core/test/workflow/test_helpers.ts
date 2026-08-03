/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {BaseNode, BaseNodeConfig} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';

/** A minimal concrete {@link BaseAgent} for driving nodes directly in tests. */
class TestAgent extends BaseAgent {
  // eslint-disable-next-line require-yield
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
  // eslint-disable-next-line require-yield
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

/** Builds a throwaway InvocationContext for driving nodes directly in tests. */
export function createIc(
  state: Record<string, unknown> = {},
): InvocationContext {
  const session = createSession({
    id: 's1',
    appName: 'app',
    userId: 'u',
    state,
    lastUpdateTime: Date.now(),
  });
  return new InvocationContext({
    invocationId: 'inv-1',
    session,
    agent: new TestAgent({name: 'wf'}),
    pluginManager: new PluginManager(),
  });
}

/** Runs a node (or workflow) to completion, returning its events and output. */
export async function driveNode(
  node: BaseNode,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<{events: Event[]; output: unknown; ctx: NodeContext}> {
  const channel = new AsyncQueue<Event>();
  const root = new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: 'root',
  });
  const events: Event[] = [];
  const settle = root.runNode(node, input, {useAsOutput: true}).then(
    () => channel.close(),
    (err) => channel.fail(err),
  );
  for await (const ev of channel) {
    events.push(ev);
  }
  await settle;
  return {events, output: root.output, ctx: root};
}

/** A node whose behavior is a plain function returning a value or Event. */
export class FnNode extends BaseNode {
  constructor(
    name: string,
    private readonly fn: (
      ctx: NodeContext,
      input: unknown,
    ) => unknown | Promise<unknown>,
    config: Partial<Omit<BaseNodeConfig, 'name'>> = {},
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}
