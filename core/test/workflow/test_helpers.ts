/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {Session} from '../../src/sessions/session.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {EventChannel} from '../../src/workflow/utils/event_channel.js';

/** Builds a throwaway InvocationContext for driving nodes directly in tests. */
export function createIc(
  state: Record<string, unknown> = {},
): InvocationContext {
  const session = {
    id: 's1',
    appName: 'app',
    userId: 'u',
    events: [],
    state,
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

/** Runs a node (or workflow) to completion, returning its events and output. */
export async function driveNode(
  node: BaseNode,
  input?: unknown,
  ic: InvocationContext = createIc(),
): Promise<{events: Event[]; output: unknown; ctx: NodeContext}> {
  const channel = new EventChannel<Event>();
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
    private readonly fn: (ctx: NodeContext, input: unknown) => unknown,
    config: {rerunOnResume?: boolean} = {},
  ) {
    super({name, ...config});
  }
  protected async *runImpl(ctx: NodeContext, input: unknown) {
    yield await this.fn(ctx, input);
  }
}
